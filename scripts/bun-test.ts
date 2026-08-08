import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { mapWithConcurrency } from './lib/map-with-concurrency.ts';
import {
  type FailedTestFile,
  githubFailureAnnotations,
  groupFailedCases,
  parseFailedCases
} from './lib/test-failure-rerun.ts';

/**
 * Platform-aware test runner. Passes through all arguments to `bun test` and
 * appends --path-ignore-patterns for suffixes that don't apply to the current OS,
 * so non-matching platform files are never loaded (no runtime skip needed).
 * Files named *.container.test.ts or *.container.<platform>.test.ts require
 * preinstalled third-party binaries and only run when MONAD_TEST_CONTAINER_DEPS=1.
 * Callers use Bun's native `--path-ignore-patterns` for suite-specific exclusions. Coverage is
 * explicit (`MONAD_TEST_COVERAGE=1`) so E2E timing is not changed merely because a command runs in CI.
 * `--monad-shards=N|auto` launches isolated Bun-native `--shard=i/N` processes. Do not replace it
 * with `--parallel`: the daemon suites require process-isolated module graphs.
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

const coverage =
  process.env.MONAD_TEST_COVERAGE === '1' ? ['--coverage', '--coverage-reporter=text', '--coverage-reporter=lcov'] : [];
const rerunLimit = 10;
const autoShardCap = 8;
const windowsShardConcurrency = 2;
const inputArgs = process.argv.slice(2);
const shardArg = inputArgs.find((arg) => arg.startsWith('--monad-shards='));
const shardValue = shardArg?.slice('--monad-shards='.length);
const shardCount =
  shardValue === 'auto'
    ? Math.max(1, Math.min(autoShardCap, navigator.hardwareConcurrency - 2))
    : shardValue
      ? Number.parseInt(shardValue, 10)
      : 1;
if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error(`invalid shard count: ${shardValue}`);
const rawArgs = inputArgs.filter((arg) => arg !== shardArg);
if (
  process.env.MONAD_TEST_CONTAINER_DEPS !== '1' &&
  rawArgs.some((arg) => /\.container(?:\.[^.]+)?\.test\.[cm]?[tj]sx?$/.test(arg))
) {
  process.stderr.write(
    '[monad-test] container dependency tests require MONAD_TEST_CONTAINER_DEPS=1 and the deps container image.\n'
  );
  process.exit(1);
}
const loud = rawArgs.includes('--loud') || Bun.env.MONAD_QUALITY_LOUD === '1';
const env = loud ? { ...Bun.env } : { ...Bun.env, AGENT: '1' };
const args = rawArgs.filter((arg) => arg !== '--loud');
const ownsReporter = !args.some((arg) => arg === '--reporter' || arg.startsWith('--reporter='));
const tempDir = !loud && ownsReporter ? mkdtempSync(join(tmpdir(), 'monad-bun-test-')) : undefined;
const junitPath = tempDir ? join(tempDir, 'junit.xml') : undefined;
const reporter = !loud && junitPath ? ['--reporter=junit', `--reporter-outfile=${junitPath}`] : [];
const loudEnv = loud ? { MONAD_TEST_DEBUG: '1' } : {};

const { exitCode, junitReports } =
  shardCount > 1 && !loud && ownsReporter ? await runNativeShards(shardCount) : await runTests();

if (exitCode !== 0 && junitReports.length > 0) {
  const failed = groupFailedCases(junitReports.flatMap((path) => parseFailedCases(readFileSync(path, 'utf8'))));
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const annotation of githubFailureAnnotations(failed)) process.stderr.write(`${annotation}\n`);
  }
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

async function runTests(): Promise<{ exitCode: number; junitReports: string[] }> {
  const proc = Bun.spawn(['bun', 'test', ...args, ...coverage, ...ignore, ...reporter], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
    env: { ...env, ...loudEnv }
  });
  const code = await proc.exited;
  return { exitCode: code, junitReports: junitPath && existsSync(junitPath) ? [junitPath] : [] };
}

async function runNativeShards(count: number): Promise<{ exitCode: number; junitReports: string[] }> {
  process.stderr.write(`[monad-test] Bun native sharding across ${count} processes\n`);
  const runShard = async (index: number) => {
    const shardJunitPath = join(tempDir as string, `junit-${index + 1}.xml`);
    const proc = Bun.spawn(
      [
        'bun',
        'test',
        ...args,
        ...coverage,
        ...ignore,
        `--shard=${index + 1}/${count}`,
        '--reporter=junit',
        `--reporter-outfile=${shardJunitPath}`
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    if (code !== 0) process.stderr.write(`${stdout}${stderr}`);
    return { code, shardJunitPath };
  };
  const indexes = Array.from({ length: count }, (_, index) => index);
  const concurrency = process.platform === 'win32' ? windowsShardConcurrency : count;
  const results = await mapWithConcurrency(indexes, concurrency, runShard);
  return {
    exitCode: results.find(({ code }) => code !== 0)?.code ?? 0,
    junitReports: results.map(({ shardJunitPath }) => shardJunitPath).filter(existsSync)
  };
}

async function rerunFailedFile(testFile: FailedTestFile): Promise<void> {
  const file = resolve(testFile.file);
  const shownFile = relative(process.cwd(), file) || testFile.file;
  process.stderr.write(`\n[monad-test] ${shownFile} - ${testFile.names.length} failed case(s)\n`);
  const proc = Bun.spawn(
    [
      'bun',
      'test',
      file,
      '--only-failures',
      ...(testFile.pattern ? ['--test-name-pattern', testFile.pattern] : []),
      ...ignore
    ],
    {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
      env: { ...env, MONAD_TEST_DEBUG: '1' }
    }
  );
  await proc.exited;
}
