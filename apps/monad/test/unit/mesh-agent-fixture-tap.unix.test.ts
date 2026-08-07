import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@monad/logger';

import { isMeshFixtureCaptureTempFileName, MeshFixtureTap } from '#/services/mesh-agent/fixture-tap.ts';

const directories: string[] = [];
const MESH_SESSION_ID = 'mesh_100000000001';
const FIRST_EPOCH = 'oep_100000000001';

function frame(payload: string) {
  return {
    provider: 'codex' as const,
    meshSessionId: MESH_SESSION_ID,
    observationEpoch: FIRST_EPOCH,
    stream: 'stdout' as const,
    payload,
    observedAt: '2026-07-20T05:29:18.291Z'
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('capture writes finalized fixtures with owner-only permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monad-fixture-tap-unix-'));
  directories.push(directory);
  const tap = new MeshFixtureTap(directory, createLogger('mesh-fixture-tap-unix-test'));
  tap.record(frame('{"type":"turn_context","payload":{"cwd":"/private/project"}}\n'));
  await tap.flush(MESH_SESSION_ID, FIRST_EPOCH);

  const files = await readdir(directory);
  const capture = files[0];
  if (!capture) throw new Error('capture wrote no fixture');
  expect({
    files,
    mode: (await stat(join(directory, capture))).mode & 0o777,
    content: await Bun.file(join(directory, capture)).text()
  }).toEqual({
    files: ['codex-mesh_100000000001-oep_100000000001.jsonl'],
    mode: 0o600,
    content: '{"type":"turn_context","payload":{"cwd":"/private/project"}}\n'
  });
});

test('a failed atomic rename leaves a private temporary capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monad-fixture-tap-unix-'));
  directories.push(directory);
  const tap = new MeshFixtureTap(directory, createLogger('mesh-fixture-tap-unix-test'), 500, {
    async rename() {
      throw new Error('injected rename failure');
    }
  });
  tap.record(frame('{"type":"session_meta","payload":{}}\n'));
  await tap.flush(MESH_SESSION_ID, FIRST_EPOCH);

  const files = await readdir(directory);
  const temporary = files[0];
  if (!temporary) throw new Error('capture did not leave its temporary file');
  expect({
    fileCount: files.length,
    temporary: isMeshFixtureCaptureTempFileName(temporary),
    mode: (await stat(join(directory, temporary))).mode & 0o777
  }).toEqual({ fileCount: 1, temporary: true, mode: 0o600 });
});
