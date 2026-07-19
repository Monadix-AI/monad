import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectTestFiles,
  nextBatchSize,
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
      'test/e2e/helpers.ts',
      'test/e2e/e.spec.ts',
      'test/e2e/f_test.ts'
    ]);
    const target = join(root, 'test/e2e');

    expect(await collectTestFiles([target], ['**/*.windows.test.ts', '**/live-*.test.ts'])).toEqual([
      join(target, 'a.test.ts'),
      join(target, 'b.test.ts'),
      join(target, 'e.spec.ts'),
      join(target, 'f_test.ts'),
      join(target, 'nested/c.test.tsx')
    ]);
  });
});

describe('nextBatchSize', () => {
  test('front-loads large batches and degrades to single files at the tail', () => {
    const shards = 4;
    const sizes: number[] = [];
    for (let remaining = 61; remaining > 0; remaining -= sizes.at(-1) as number) {
      sizes.push(Math.min(nextBatchSize(remaining, shards), remaining));
    }

    expect(sizes).toEqual([8, 7, 6, 5, 5, 4, 4, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(sizes.reduce((total, size) => total + size, 0)).toBe(61);
  });

  test('never returns a zero batch, which would spin the worker loop forever', () => {
    expect(nextBatchSize(1, 8)).toBe(1);
  });
});

describe('runShardedTestFiles', () => {
  test('runs every file exactly once and reports the failing exit code', async () => {
    const ran: string[] = [];
    const exitCode = await runShardedTestFiles({
      files: ['ok-1', 'fail-2', 'ok-3', 'ok-4'],
      shards: 2,
      junitDir: '/tmp',
      env: {},
      buildCommand: (batch) => [
        'bash',
        '-c',
        `echo ran ${batch.join(' ')}; exit ${batch.some((file) => file.startsWith('fail')) ? 3 : 0}`
      ],
      onResult: (result) => ran.push(...result.output.trim().replace('ran ', '').split(' '))
    });

    expect(exitCode).toBe(3);
    expect(ran.sort()).toEqual(['fail-2', 'ok-1', 'ok-3', 'ok-4']);
  });

  test('reports the whole batch a failing process covered so its cases can be reattributed', async () => {
    const results: Array<{ files: string[]; exitCode: number }> = [];
    await runShardedTestFiles({
      files: ['a', 'b', 'c', 'd'],
      shards: 1,
      junitDir: '/tmp',
      env: {},
      buildCommand: () => ['bash', '-c', 'exit 1'],
      onResult: (result) => results.push({ files: result.files, exitCode: result.exitCode })
    });

    expect(results).toEqual([
      { files: ['a', 'b'], exitCode: 1 },
      { files: ['c'], exitCode: 1 },
      { files: ['d'], exitCode: 1 }
    ]);
  });

  test('bounds concurrency to the shard count', async () => {
    let running = 0;
    let peak = 0;
    await runShardedTestFiles({
      files: ['a', 'b', 'c', 'd', 'e', 'f'],
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
