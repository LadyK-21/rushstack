import { createFsFromVolume, Volume, IFs } from 'memfs';
import path from 'path';
import webpack from 'webpack';
import type { StatsCompilation as WebpackStatsCompilation } from 'webpack';
import webpackMerge from 'webpack-merge';

import type { MultiStats, Stats, Configuration, Compiler, StatsError } from 'webpack';

/**
 * @public
 * This function generates a webpack compiler with default configuration and the output filesystem mapped to
 * a memory filesystem. This is useful for testing webpack plugins/loaders where we do not need to write to disk (which can be costly).
 * @param entry - The entry point for the webpack compiler
 * @param additionalConfig - Any additional configuration that should be merged with the default configuration
 * @param memFs - The memory filesystem to use for the output filesystem. Use this option if you want to _inspect_, analyze, or read the output
 * files generated by the webpack compiler. If you do not need to do this, you can omit this parameter and the output files.
 *
 * @returns - A webpack compiler with the output filesystem mapped to a memory filesystem
 */
export async function getTestingWebpackCompiler(
  entry: string,
  additionalConfig: Configuration = {},
  memFs: IFs = createFsFromVolume(new Volume())
): Promise<(Stats | MultiStats) | undefined> {
  const compilerOptions: Configuration = webpackMerge(_defaultWebpackConfig(entry), additionalConfig);
  const compiler: Compiler = webpack(compilerOptions);

  compiler.outputFileSystem = memFs;
  compiler.outputFileSystem.join = path.join.bind(path);

  return new Promise((resolve, reject) => {
    compiler.run((err, stats) => {
      if (err) {
        return reject(err);
      }

      _processAndHandleStatsErrorsAndWarnings(stats, reject);

      resolve(stats);
    });
  });
}

function _processAndHandleStatsErrorsAndWarnings(
  stats: Stats | MultiStats | undefined,
  reject: (reason: unknown) => void
): void {
  if (stats?.hasErrors() || stats?.hasWarnings()) {
    const serializedStats: WebpackStatsCompilation[] = [stats?.toJson('errors-warnings')];

    const errors: StatsError[] = [];
    const warnings: StatsError[] = [];

    for (const compilationStats of serializedStats) {
      if (compilationStats.warnings) {
        for (const warning of compilationStats.warnings) {
          warnings.push(warning);
        }
      }

      if (compilationStats.errors) {
        for (const error of compilationStats.errors) {
          errors.push(error);
        }
      }

      if (compilationStats.children) {
        for (const child of compilationStats.children) {
          serializedStats.push(child);
        }
      }
    }

    reject([...errors, ...warnings]);
  }
}

function _defaultWebpackConfig(entry: string = './src'): Configuration {
  return {
    // We don't want to have eval source maps, nor minification
    // so we set mode to 'none' to disable both. Default is 'production'
    mode: 'none',
    context: __dirname,
    entry,
    output: {
      filename: 'test-bundle.js'
    }
  };
}
