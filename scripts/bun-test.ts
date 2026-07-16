import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { type FailedTestFile, groupFailedCases, parseFailedCases } from './lib/test-failure-rerun.ts';

/**
 * Platform-aware test runner. Passes through all arguments to `bun test` and
 * appends --path-ignore-patterns for suffixes that don't apply to the current OS,
 * so non-matching platform files are never loaded (no runtime skip needed).
 * Files named *.container.test.ts or *.container.<platform>.test.ts require
 * preinstalled third-party binaries and only run when MONAD_TEST_CONTAINER_DEPS=1.
 *
 * Suffix → platforms where the file SHOULD run:
 *   .unix.test.ts    → darwin + linux
 *   .macos.test.ts   → darwin only
 *   .linux.test.ts   → linux only
 *   .windows.test.ts → win32 only
 *
 * Files with no platform suffix run everywhere.
 *
 * THIS SCRIPT IS LOAD-BEARING — do not replace it with plain `bun test`, and do
 * not assume the in-file `if (process.platform !== ...) process.exit(0)` guards
 * make it redundant. They do not, for two reasons:
 *
 *   1. process.exit(0) kills the WHOLE test process, not just one file. When Bun
 *      runs a directory it evaluates every test file up front to register tests;
 *      the first platform-mismatched file to hit its guard would abort the entire
 *      suite. File-level exclusion here is what prevents those files from ever
 *      being evaluated, so the guards never fire during a normal run.
 *
 *   2. A guard cannot run before the file's own static imports. ESM evaluates
 *      imported modules before any top-level statement of the importer, so a guard
 *      — even on line 1 — runs AFTER its imports. A static import that loads
 *      platform-only code at module top level (e.g. dlopen('kernel32')) throws on
 *      the wrong OS before the guard can exit.
 *
 * The guards exist ONLY as a safety net for running a single platform file
 * directly (`bun test path/to/x.macos.test.ts`) on the wrong OS. For them to work
 * even then, platform-specific native code (FFI/dlopen) MUST be loaded lazily
 * (inside a function / `await import(...)`), never at module top level.
 *
 * Test output policy:
 *
 *   Why: the daemon tests intentionally exercise noisy request/logging paths. Dumping every
 *   passing case's logger output makes agent/debug sessions expensive and hides the actual
 *   failing assertion.
 *
 *   How: the default run keeps Bun's agent-friendly reporter on and relies on NODE_ENV=test
 *   to make @monad/logger silent. If a run fails, this wrapper reads a temporary JUnit report,
 *   reruns only the failed test names, and injects a temporary preload that calls setLogLevel('debug').
 *   `--loud` skips the quiet reporter/rerun path and injects that same preload for the whole run.
 */

const SUFFIX_PLATFORMS: Record<string, NodeJS.Platform[]> = {
  unix: ['darwin', 'linux'],
  macos: ['darwin'],
  linux: ['linux'],
  windows: ['win32']
};

const ignore = Object.entries(SUFFIX_PLATFORMS)
  .filter(([, platforms]) => !platforms.includes(process.platform))
  .flatMap(([suffix]) => ['--path-ignore-patterns', `**/*.${suffix}.test.ts`]);
if (process.env.MONAD_TEST_CONTAINER_DEPS !== '1') {
  ignore.push('--path-ignore-patterns', '**/*.container.test.ts');
  ignore.push('--path-ignore-patterns', '**/*.container.*.test.ts');
}

const coverage = process.env.CI ? ['--coverage'] : [];
const rerunLimit = 10;
const rawArgs = process.argv.slice(2);
if (
  process.env.MONAD_TEST_CONTAINER_DEPS !== '1' &&
  rawArgs.some((arg) => /\.container(?:\.[^.]+)?\.test\.[cm]?[tj]sx?$/.test(arg))
) {
  process.stderr.write(
    '[monad-test] container dependency tests require MONAD_TEST_CONTAINER_DEPS=1 and the deps container image.\n'
  );
  process.exit(1);
}
const loud = rawArgs.includes('--loud');
const env = loud ? { ...Bun.env } : { ...Bun.env, AGENT: '1' };
const args = rawArgs.filter((arg) => arg !== '--loud');
const ownsReporter = !args.some((arg) => arg === '--reporter' || arg.startsWith('--reporter='));
const tempDir = loud || ownsReporter ? mkdtempSync(join(tmpdir(), 'monad-bun-test-')) : undefined;
const junitPath = tempDir ? join(tempDir, 'junit.xml') : undefined;
const reporter = !loud && junitPath ? ['--reporter=junit', `--reporter-outfile=${junitPath}`] : [];
let _debugPreloadPath: string | undefined;
const loudPreload = loud ? ['--preload', debugPreloadPath()] : [];

const proc = Bun.spawn(['bun', 'test', ...loudPreload, ...args, ...coverage, ...ignore, ...reporter], {
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'inherit',
  env
});
const exitCode = await proc.exited;

if (exitCode !== 0 && junitPath && existsSync(junitPath)) {
  const failed = groupFailedCases(parseFailedCases(readFileSync(junitPath, 'utf8')));
  const selected = failed.slice(0, rerunLimit);
  if (selected.length > 0) {
    process.stderr.write('\n[monad-test] Re-running failed files with logger output enabled\n');
    for (const testFile of selected) {
      await rerunFailedFile(testFile);
    }
  }
  if (selected.length < failed.length) {
    process.stderr.write(
      `\n[monad-test] Skipped debug reruns for ${failed.length - selected.length} additional failed file(s).\n`
    );
  }
}

if (tempDir) rmSync(tempDir, { recursive: true, force: true });
process.exit(exitCode);

async function rerunFailedFile(testFile: FailedTestFile): Promise<void> {
  const file = resolve(testFile.file);
  const shownFile = relative(process.cwd(), file) || testFile.file;
  process.stderr.write(`\n[monad-test] ${shownFile} - ${testFile.names.length} failed case(s)\n`);
  const proc = Bun.spawn(
    [
      'bun',
      'test',
      '--preload',
      debugPreloadPath(),
      file,
      '--only-failures',
      ...(testFile.pattern ? ['--test-name-pattern', testFile.pattern] : []),
      ...ignore
    ],
    {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
      env
    }
  );
  await proc.exited;
}

function debugPreloadPath(): string {
  if (_debugPreloadPath) return _debugPreloadPath;
  const dir = tempDir ?? mkdtempSync(join(tmpdir(), 'monad-bun-test-'));
  const levelPath = resolve(dirname(import.meta.path), '../packages/logger/src/level.ts');
  _debugPreloadPath = join(dir, 'log-debug.ts');
  writeFileSync(
    _debugPreloadPath,
    `import { setLogLevel } from ${JSON.stringify(levelPath)};\nsetLogLevel('debug');\n`
  );
  return _debugPreloadPath;
}
