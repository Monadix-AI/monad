import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectTestFiles,
  parseMonadTestShardArgs,
  runShardedTestFiles,
  shardableTargets
} from '../../lib/test-shard.ts';

function fixtureTree(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'monad-shard-'));
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '');
  }
  return root;
}

describe('parseMonadTestShardArgs', () => {
  test('leaves ordinary Bun arguments and the default shard count untouched', () => {
    expect(parseMonadTestShardArgs(['test/e2e/', '--only-failures'], 14)).toEqual({
      args: ['test/e2e/', '--only-failures'],
      shards: 1
    });
  });

  test('strips an explicit shard count out of the Bun argument list', () => {
    expect(parseMonadTestShardArgs(['test/e2e/', '--monad-shards=6'], 14)).toEqual({
      args: ['test/e2e/'],
      shards: 6
    });
  });

  test('caps auto sharding so a large host does not spawn an unbounded pool', () => {
    expect(parseMonadTestShardArgs(['--monad-shards=auto'], 64)).toEqual({ args: [], shards: 4 });
  });

  test('disables auto sharding on a host too small to overlap shards', () => {
    expect(parseMonadTestShardArgs(['--monad-shards=auto'], 2)).toEqual({ args: [], shards: 1 });
  });

  test('rejects a shard count Bun could otherwise receive as a stray argument', () => {
    expect(() => parseMonadTestShardArgs(['--monad-shards=0'], 14)).toThrow('invalid shard count: 0');
  });
});

describe('shardableTargets', () => {
  test('returns the directory targets whose file selection sharding can reproduce', () => {
    const root = fixtureTree(['test/e2e/a.test.ts']);
    expect(shardableTargets([join(root, 'test/e2e'), '--only-failures'])).toEqual([join(root, 'test/e2e')]);
  });

  test('declines a name filter so the run keeps Bun as the single selection authority', () => {
    const root = fixtureTree(['test/e2e/a.test.ts']);
    expect(shardableTargets([join(root, 'test/e2e'), '-t', 'some case'])).toBeUndefined();
    expect(shardableTargets([join(root, 'test/e2e'), '--test-name-pattern=some case'])).toBeUndefined();
  });

  test('declines an explicit file target', () => {
    const root = fixtureTree(['test/e2e/a.test.ts']);
    expect(shardableTargets([join(root, 'test/e2e/a.test.ts')])).toBeUndefined();
  });

  test('does not mistake an ignore pattern for a target directory', () => {
    const root = fixtureTree(['test/e2e/a.test.ts']);
    expect(shardableTargets([join(root, 'test/e2e'), '--path-ignore-patterns', '**/*.windows.test.ts'])).toEqual([
      join(root, 'test/e2e')
    ]);
  });
});

describe('collectTestFiles', () => {
  test('collects test files in stable order and drops ignored ones', async () => {
    const root = fixtureTree([
      'test/e2e/b.test.ts',
      'test/e2e/a.test.ts',
      'test/e2e/nested/c.test.tsx',
      'test/e2e/d.windows.test.ts',
      'test/e2e/live-model.test.ts',
      'test/e2e/helpers.ts'
    ]);
    const target = join(root, 'test/e2e');

    expect(await collectTestFiles([target], ['**/*.windows.test.ts', '**/live-*.test.ts'])).toEqual([
      join(target, 'a.test.ts'),
      join(target, 'b.test.ts'),
      join(target, 'nested/c.test.tsx')
    ]);
  });
});

describe('runShardedTestFiles', () => {
  test('runs every file exactly once and reports the failing exit code', async () => {
    const seen: string[] = [];
    const exitCode = await runShardedTestFiles({
      files: ['ok-1', 'fail-2', 'ok-3', 'ok-4'],
      shards: 2,
      junitDir: '/tmp',
      env: {},
      buildCommand: (file) => ['bash', '-c', `echo ran ${file}; exit ${file.startsWith('fail') ? 3 : 0}`],
      onResult: (result) => seen.push(`${result.file}:${result.exitCode}:${result.output.trim()}`)
    });

    expect(exitCode).toBe(3);
    expect(seen.sort()).toEqual(['fail-2:3:ran fail-2', 'ok-1:0:ran ok-1', 'ok-3:0:ran ok-3', 'ok-4:0:ran ok-4']);
  });

  test('bounds concurrency to the shard count', async () => {
    let running = 0;
    let peak = 0;
    const files = ['a', 'b', 'c', 'd', 'e', 'f'];
    await runShardedTestFiles({
      files,
      shards: 2,
      junitDir: '/tmp',
      env: {},
      buildCommand: () => {
        running++;
        peak = Math.max(peak, running);
        return ['bash', '-c', 'sleep 0.05'];
      },
      onResult: () => {
        running--;
      }
    });

    expect(peak).toBe(2);
  });
});
