import { describe, expect, test } from 'bun:test';

import { parseMonadTestSuiteArgs } from '../../lib/test-suite.ts';

describe('parseMonadTestSuiteArgs', () => {
  test('keeps ordinary Bun arguments unchanged', () => {
    expect(parseMonadTestSuiteArgs(['test/unit/', '--only-failures'])).toEqual({
      args: ['test/unit/', '--only-failures'],
      ignorePatterns: []
    });
  });

  test('turns the hermetic E2E wrapper option into pre-load exclusions', () => {
    expect(parseMonadTestSuiteArgs(['test/e2e/', '--monad-suite=hermetic-e2e', '--only-failures'])).toEqual({
      args: ['test/e2e/', '--only-failures'],
      ignorePatterns: ['**/live-*.test.ts', '**/*.local.test.ts']
    });
  });

  test('rejects unknown Monad suite names instead of leaking them to Bun', () => {
    expect(() => parseMonadTestSuiteArgs(['--monad-suite=unknown'])).toThrow('unknown Monad test suite: unknown');
  });
});
