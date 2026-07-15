import { expect, test } from 'bun:test';

import { checkDependencyDirections, defaultDependencyPolicy, type WorkspacePackage } from '../../dependency-policy.ts';

const pkg = (
  name: string,
  dir: string,
  dependencies: string[] = [],
  devDependencies: string[] = []
): WorkspacePackage => ({ dependencies, devDependencies, dir, name });

test('packages may not depend on executable apps', () => {
  const violations = checkDependencyDirections(
    [pkg('@monad/shared', 'packages/shared', ['@monad/web']), pkg('@monad/web', 'apps/web')],
    defaultDependencyPolicy
  );

  expect(violations).toEqual([
    {
      dependencyKind: 'runtime',
      from: '@monad/shared',
      fromDir: 'packages/shared',
      to: '@monad/web',
      toDir: 'apps/web'
    }
  ]);
});

test('the CLI may compose the daemon, TUI, and web release applications', () => {
  const violations = checkDependencyDirections(
    [
      pkg('@monad/cli', 'apps/cli', ['@monad/monad', '@monad/tui', '@monad/web']),
      pkg('@monad/monad', 'apps/monad'),
      pkg('@monad/tui', 'apps/tui'),
      pkg('@monad/web', 'apps/web')
    ],
    defaultDependencyPolicy
  );

  expect(violations).toEqual([]);
});

test('unrecorded app-to-app dependencies remain violations', () => {
  const violations = checkDependencyDirections(
    [pkg('@monad/web', 'apps/web', ['@monad/monad']), pkg('@monad/monad', 'apps/monad')],
    defaultDependencyPolicy
  );

  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatchObject({
    dependencyKind: 'runtime',
    from: '@monad/web',
    to: '@monad/monad'
  });
});

test('runtime and development-only dependency violations are distinguished', () => {
  const violations = checkDependencyDirections(
    [pkg('@monad/web', 'apps/web', [], ['@monad/monad']), pkg('@monad/monad', 'apps/monad')],
    { allowedAppDependencies: [] }
  );

  expect(violations[0]?.dependencyKind).toBe('development');
});
