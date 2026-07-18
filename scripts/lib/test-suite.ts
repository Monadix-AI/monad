const SUITE_ARG_PREFIX = '--monad-suite=';

export interface MonadTestSuiteArgs {
  args: string[];
  ignorePatterns: string[];
}

export function parseMonadTestSuiteArgs(input: string[]): MonadTestSuiteArgs {
  const args: string[] = [];
  const ignorePatterns: string[] = [];

  for (const arg of input) {
    if (!arg.startsWith(SUITE_ARG_PREFIX)) {
      args.push(arg);
      continue;
    }

    const suite = arg.slice(SUITE_ARG_PREFIX.length);
    if (suite !== 'hermetic-e2e') throw new Error(`unknown Monad test suite: ${suite}`);
    ignorePatterns.push('**/live-*.test.ts', '**/*.local.test.ts');
  }

  return { args, ignorePatterns: [...new Set(ignorePatterns)] };
}
