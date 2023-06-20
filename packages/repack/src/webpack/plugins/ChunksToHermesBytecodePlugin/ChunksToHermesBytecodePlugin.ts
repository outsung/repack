import path from 'path';
import fs from 'fs-extra';

import { ModuleFilenameHelpers } from 'webpack';

import type { Compiler } from 'webpack';
import type { Rule, WebpackEnvOptions, WebpackPlugin } from '../../../types';

import {
  composeSourceMaps,
  getHermesCLIPath,
  transformBundleToHermesBytecode,
} from './utils';

/**
 * Checks if a file exists.
 */
const fileExists = async (path: string) => {
  try {
    await fs.access(path);
    return true;
  } catch (_e) {
    return false;
  }
};

type SharedOptions = Pick<
  WebpackEnvOptions,
  | 'platform'
  | 'bundleFilename'
  | 'sourceMapFilename'
  | 'assetsPath'
  | 'reactNativePath'
>;

/**
 * {@link ChunksToHermesBytecodePlugin} configuration options.
 */
interface ChunksToHermesBytecodePluginConfig extends SharedOptions {
  /**
   * Whether the plugin is enabled.
   *
   * Since hermes compilation of chunks is not necessary for every build, this
   * option allows one to enable/disable the plugin. Normally, you would only
   * enable this plugin for production builds.
   */
  enabled: boolean;

  /** Path to the Hermes compiler binary. */
  hermesCLIPath?: string;

  /** Matching files will be converted to Hermes bytecode. */
  test?: Rule | Rule[];

  /** Include matching files in conversion to Hermes bytecode. */
  include?: Rule | Rule[];

  /** Exclude matching files from conversion to Hermes bytecode. */
  exclude?: Rule | Rule[];
}

/**
 * Enable Hermes bytecode compilation for the given chunks. This plugin is intended to be used with the `webpack-bundle` command.
 * It will transform the bundle into Hermes bytecode and replace the original bundle with the bytecode. It will also compose the source maps generated by webpack and Hermes. The source maps will be saved to the `sourceMapFilename` path.
 *
 * Note: This plugin should only be used for production builds. It is not possible to use this plugin for development builds.
 *
 * @example ```js
 * // webpack.config.mjs
 * import * as Repack from '@callstack/repack';
 *
 * // ...
 * plugins: [
 *   // Must appear after `Repack.OutputPlugin`, which is used by default in `Repack.RepackPlugin`
 *   new Repack.ChunksToHermesBytecodePlugin({
 *    enabled: mode === 'production' && !devServer,
 *    test: /\.(js)?bundle$/,
 *    platform,
 *    reactNativePath,
 *    bundleFilename,
 *    sourceMapFilename,
 *    assetsPath,
 *   }),
 * ]
 * ```
 *
 * @category Webpack Plugin
 */
export class ChunksToHermesBytecodePlugin implements WebpackPlugin {
  private readonly name = 'ChunksToHermesBytecodePlugin';

  constructor(private config: ChunksToHermesBytecodePluginConfig) {}

  apply(compiler: Compiler) {
    const logger = compiler.getInfrastructureLogger(this.name);

    if (!this.config.enabled) {
      logger.info('Skipping hermes compilation');
      return;
    }

    const {
      platform,
      bundleFilename,
      sourceMapFilename,
      assetsPath,
      reactNativePath = './node_modules/react-native',
    } = this.config;

    if (!bundleFilename) {
      logger.error(
        `Hermes compilation is only supported for the 'webpack-bundle' command. You can disable this plugin via the 'enabled' option.`
      );
      logger.info(
        `Did you forget to provide an explicit '--bundle-output <path>' option to 'webpack-bundle'?`
      );

      throw new Error(
        'Hermes compilation is only supported for bundle builds with --bundle-output'
      );
    }

    const shouldUseHermesByteCode = (filename: string) =>
      ModuleFilenameHelpers.matchObject(this.config, filename);

    const hermesCLIPath =
      this.config.hermesCLIPath || getHermesCLIPath(reactNativePath);

    /** Directory where the bundle is saved */
    const bundleOutputDir = path.dirname(bundleFilename);

    /** Directory where assets are saved */
    const assetsOutputDir = assetsPath || bundleOutputDir;

    /** Directory where source maps are saved */
    const sourcemapOutputDir = sourceMapFilename
      ? path.dirname(sourceMapFilename)
      : bundleOutputDir;

    compiler.hooks.afterEmit.tapPromise(this.name, async (compilation) => {
      await Promise.all(
        compilation
          .getAssets()
          .filter((asset) => shouldUseHermesByteCode(asset.name))
          .map(async (asset) => {
            /**
             * Logic based on implementations for each platform.
             * #### iOS
             * - Logic in [react-native-xcode.sh](https://github.com/facebook/react-native/blob/f38fc9ba8681622f7cfdb586753e50c596946929/packages/react-native/scripts/react-native-xcode.sh#L166-L187)
             *
             * #### Android
             * - Defaults in [ReactExtension.kt](https://github.com/facebook/react-native/blob/f38fc9ba8681622f7cfdb586753e50c596946929/packages/react-native-gradle-plugin/src/main/kotlin/com/facebook/react/ReactExtension.kt#L116-L117)
             * - Logic in [BundleHermesCTask.kt](https://github.com/facebook/react-native/blob/f38fc9ba8681622f7cfdb586753e50c596946929/packages/react-native-gradle-plugin/src/main/kotlin/com/facebook/react/tasks/BundleHermesCTask.kt#L93-L111)
             */

            logger.debug(
              `Starting hermes compilation for asset: ${asset.name}`
            );
            const assetPath = compilation.getPath(asset.name);

            // TODO: extract the following logic calculating paths to a separate
            // function, share with OutputPlugin, or maybe integrate?
            const isMainBundle = asset.name === 'index.bundle';

            const bundleOutputPath = isMainBundle
              ? bundleFilename
              : path.join(
                  platform === 'ios' ? assetsOutputDir : bundleOutputDir,
                  assetPath
                );

            const bundleExists = await fileExists(bundleOutputPath);
            if (!bundleExists) {
              logger.error(`Bundle does not exist: ${bundleOutputPath}`);
              // TODO: for now ignore this, consider throwing an error when remote
              // assets are supported
              return;
            }

            const sourcemapOutputPath =
              !isMainBundle && platform === 'ios'
                ? `${bundleOutputPath}.map`
                : path.join(
                    sourcemapOutputDir,
                    `${path.basename(bundleOutputPath)}.map`
                  );

            const packagerMapPath = path.join(
              sourcemapOutputDir,
              `${path.basename(bundleOutputPath)}.packager.map`
            );

            const useSourceMaps = await fileExists(sourcemapOutputPath);
            if (useSourceMaps) {
              await fs.rename(sourcemapOutputPath, packagerMapPath);
            } else {
              logger.info(
                `No source maps found, did you forget to specify '--sourcemap-output'?`
              );
            }

            const hermesAsset = await transformBundleToHermesBytecode({
              hermesCLIPath,
              useSourceMaps,
              filePath: bundleOutputPath,
            });

            logger.info(`Asset transformed: ${assetPath}`);

            if (useSourceMaps) {
              await composeSourceMaps({
                reactNativePath,
                packagerMapPath,
                compilerMapPath: hermesAsset.sourceMap,
                outputFile: sourcemapOutputPath,
              });
            }
          })
      );

      return;
    });
  }
}
