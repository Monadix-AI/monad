import { expect, test } from 'bun:test';

import { ignoredTestPathPatterns, testFileAppliesToPlatform } from '../../lib/platform-test-files.ts';

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'linux', 'win32'];
const NAMES = [
  'session.test.ts',
  'sockets.unix.test.ts',
  'keychain.macos.test.ts',
  'landlock.linux.test.ts',
  'appcontainer.windows.test.ts',
  'bwrap.container.test.ts',
  'bwrap.container.linux.test.ts',
  'helpers.ts'
];

test('a platform excludes exactly the suffixes it cannot run', () => {
  expect({
    darwin: ignoredTestPathPatterns('darwin'),
    linux: ignoredTestPathPatterns('linux'),
    win32: ignoredTestPathPatterns('win32'),
    win32WithContainers: ignoredTestPathPatterns('win32', { containerDeps: true })
  }).toEqual({
    darwin: ['**/*.linux.test.ts', '**/*.windows.test.ts', '**/*.container.test.ts', '**/*.container.*.test.ts'],
    linux: ['**/*.macos.test.ts', '**/*.windows.test.ts', '**/*.container.test.ts', '**/*.container.*.test.ts'],
    win32: [
      '**/*.unix.test.ts',
      '**/*.macos.test.ts',
      '**/*.linux.test.ts',
      '**/*.container.test.ts',
      '**/*.container.*.test.ts'
    ],
    win32WithContainers: ['**/*.unix.test.ts', '**/*.macos.test.ts', '**/*.linux.test.ts']
  });
});

test('applicability follows the platform suffix and the container opt-in', () => {
  expect(
    Object.fromEntries(
      NAMES.map((name) => [
        name,
        PLATFORMS.filter((platform) => testFileAppliesToPlatform(name, platform)).join(',') || 'none'
      ])
    )
  ).toEqual({
    'session.test.ts': 'darwin,linux,win32',
    'sockets.unix.test.ts': 'darwin,linux',
    'keychain.macos.test.ts': 'darwin',
    'landlock.linux.test.ts': 'linux',
    'appcontainer.windows.test.ts': 'win32',
    'bwrap.container.test.ts': 'none',
    'bwrap.container.linux.test.ts': 'none',
    'helpers.ts': 'none'
  });
  expect(testFileAppliesToPlatform('bwrap.container.linux.test.ts', 'linux', { containerDeps: true })).toBe(true);
  expect(testFileAppliesToPlatform('bwrap.container.linux.test.ts', 'darwin', { containerDeps: true })).toBe(false);
});

// The two consumers read the same table: `bun test` receives the exclusion patterns, while a runner
// that enumerates files itself asks the predicate. A file one side drops and the other keeps is the
// drift this module exists to prevent.
test('every name the exclusion patterns drop is also rejected by the predicate', () => {
  const disagreements = PLATFORMS.flatMap((platform) => {
    const excluded = new Bun.Glob(`{${ignoredTestPathPatterns(platform).join(',')}}`);
    return NAMES.filter((name) => name.endsWith('.test.ts')).flatMap((name) =>
      excluded.match(`pkg/test/unit/${name}`) === testFileAppliesToPlatform(name, platform)
        ? [`${platform}:${name}`]
        : []
    );
  });

  expect(disagreements).toEqual([]);
});
