import type { LoggerRecord } from '@monad/logger';

import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLogger, createLogger } from '@monad/logger';

import {
  isMeshFixtureCaptureFileName,
  isMeshFixtureCaptureTempFileName,
  MeshFixtureTap
} from '#/services/mesh-agent/fixture-tap.ts';

const log = createLogger('mesh-fixture-tap-test');
const directories: string[] = [];
const MESH_SESSION_ID = 'mesh_100000000001';
const FIRST_EPOCH = 'oep_100000000001';
const SECOND_EPOCH = 'oep_100000000002';

afterEach(async () => {
  configureLogger(undefined);
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tapWith(maxRecords?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'monad-fixture-tap-'));
  directories.push(directory);
  return { directory, tap: new MeshFixtureTap(directory, log, maxRecords) };
}

function frame(payload: string, over: { stream?: 'stdout' | 'stderr'; epoch?: string } = {}) {
  return {
    provider: 'codex' as const,
    meshSessionId: MESH_SESSION_ID,
    observationEpoch: over.epoch ?? FIRST_EPOCH,
    stream: over.stream ?? ('stdout' as const),
    payload,
    observedAt: '2026-07-20T05:29:18.291Z'
  };
}

async function readFixture(directory: string) {
  const files = await readdir(directory);
  const name = files[0];
  if (!name) throw new Error('capture wrote no fixture');
  const text = await Bun.file(join(directory, name)).text();
  return {
    name,
    text,
    records: text
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  };
}

test('a provider frame split across two packets is captured verbatim as one record', async () => {
  const { directory, tap } = await tapWith();

  tap.record(frame('{"type":"event_msg","payload":{"type":"agent_m'));
  tap.record(frame('essage","message":"ship it"}}\n'));
  await tap.flush(MESH_SESSION_ID, FIRST_EPOCH);

  const { name, text, records } = await readFixture(directory);
  expect({ name, text, records }).toEqual({
    name: 'codex-mesh_100000000001-oep_100000000001.jsonl',
    text: '{"type":"event_msg","payload":{"type":"agent_message","message":"ship it"}}\n',
    records: [{ type: 'event_msg', payload: { type: 'agent_message', message: 'ship it' } }]
  });
});

test('capture preserves real paths and secrets and writes owner-only', async () => {
  const logRecords: LoggerRecord[] = [];
  configureLogger({
    destinations: [
      {
        type: 'custom',
        name: 'fixture-tap-success',
        level: 'info',
        write(record) {
          logRecords.push(record);
        }
      }
    ]
  });
  const { directory, tap } = await tapWith();

  tap.record(frame('{"type":"turn_context","payload":{"cwd":"/Users/test/secret-repo","api_key":"sk-live-abc123"}}\n'));
  await tap.flush(MESH_SESSION_ID, FIRST_EPOCH);

  const { name, records } = await readFixture(directory);
  const mode = (await stat(join(directory, name))).mode & 0o777;
  // Verbatim on purpose: redaction is the promotion step's job (scripts/mesh-fixture.ts), so the
  // on-disk capture must still be exactly what the provider emitted.
  expect({
    ...(process.platform === 'win32' ? {} : { mode }),
    record: records[0],
    logged: logRecords.map((record) => ({ event: record.event, basename: record.basename, path: record.path }))
  }).toEqual({
    ...(process.platform === 'win32' ? {} : { mode: 0o600 }),
    record: { type: 'turn_context', payload: { cwd: '/Users/test/secret-repo', api_key: 'sk-live-abc123' } },
    logged: [
      {
        event: 'mesh.fixture_capture_written',
        basename: 'codex-mesh_100000000001-oep_100000000001.jsonl',
        path: undefined
      }
    ]
  });
});

test('an incomplete trailing frame is held back rather than written as a broken record', async () => {
  const { directory, tap } = await tapWith();

  tap.record(frame('{"type":"session_meta","payload":{}}\n{"type":"turn_conte'));
  await tap.flush(MESH_SESSION_ID, FIRST_EPOCH);

  const { records } = await readFixture(directory);
  expect(records).toEqual([{ type: 'session_meta', payload: {} }]);
});

test('capture stops at maxRecords and ignores stderr', async () => {
  const { directory, tap } = await tapWith(2);

  for (let index = 0; index < 5; index++) tap.record(frame(`{"type":"event_msg","payload":{"index":${index}}}\n`));
  tap.record(frame('{"type":"event_msg","payload":{"index":99}}\n', { stream: 'stderr' }));
  await tap.flush(MESH_SESSION_ID, FIRST_EPOCH);

  const { records } = await readFixture(directory);
  expect(records.map((record: { payload: { index: number } }) => record.payload.index)).toEqual([0, 1]);
});

test('each observation epoch flushes to its own capture file', async () => {
  const { directory, tap } = await tapWith();

  tap.record(frame('{"type":"event_msg","payload":{"epoch":1}}\n', { epoch: FIRST_EPOCH }));
  tap.record(frame('{"type":"event_msg","payload":{"epoch":2}}\n', { epoch: SECOND_EPOCH }));
  await tap.flush(MESH_SESSION_ID, FIRST_EPOCH);
  await tap.flush(MESH_SESSION_ID, SECOND_EPOCH);

  const files = (await readdir(directory)).sort();
  const payloads = await Promise.all(
    files.map(async (name) => JSON.parse(await Bun.file(join(directory, name)).text()).payload)
  );
  expect({ files, payloads }).toEqual({
    files: ['codex-mesh_100000000001-oep_100000000001.jsonl', 'codex-mesh_100000000001-oep_100000000002.jsonl'],
    payloads: [{ epoch: 1 }, { epoch: 2 }]
  });
});

test('a flush with no complete frame writes nothing', async () => {
  const { directory, tap } = await tapWith();

  tap.record(frame('{"type":"event_msg","payl'));
  await tap.flush(MESH_SESSION_ID, FIRST_EPOCH);

  expect(await readdir(directory)).toEqual([]);
});

test('capture matchers are the canonical inverse of tap-owned provider encoding', () => {
  const validProviders = ['codex', '.hidden', 'space provider', 'path/provider', 'path\\provider', '100%'];
  const validFinals = validProviders.map(
    (provider) => `${encodeURIComponent(provider)}-mesh_aB3dE5gH7jK9-oep_Z9y8X7w6V5u4.jsonl`
  );
  expect({
    writerOutput: validFinals.map(isMeshFixtureCaptureFileName),
    leadingDotTemp: isMeshFixtureCaptureTempFileName(
      '..hidden-mesh_100000000001-oep_100000000001.jsonl.123e4567-e89b-42d3-a456-426614174000.tmp'
    ),
    uppercaseSyntax: [
      isMeshFixtureCaptureFileName('codex-MESH_100000000001-oep_100000000001.jsonl'),
      isMeshFixtureCaptureFileName('codex-mesh_100000000001-OEP_100000000001.jsonl'),
      isMeshFixtureCaptureFileName('codex-mesh_100000000001-oep_100000000001.JSONL'),
      isMeshFixtureCaptureTempFileName(
        '.codex-mesh_100000000001-oep_100000000001.jsonl.123e4567-e89b-42d3-a456-426614174000.TMP'
      ),
      isMeshFixtureCaptureTempFileName(
        '.codex-mesh_100000000001-oep_100000000001.jsonl.123E4567-e89b-42d3-a456-426614174000.tmp'
      )
    ],
    lookalikes: [
      isMeshFixtureCaptureFileName('space provider-mesh_100000000001-oep_100000000001.jsonl'),
      isMeshFixtureCaptureFileName('path/provider-mesh_100000000001-oep_100000000001.jsonl'),
      isMeshFixtureCaptureFileName('path\\provider-mesh_100000000001-oep_100000000001.jsonl'),
      isMeshFixtureCaptureFileName('%2f-mesh_100000000001-oep_100000000001.jsonl'),
      isMeshFixtureCaptureFileName('%2Ehidden-mesh_100000000001-oep_100000000001.jsonl'),
      isMeshFixtureCaptureFileName('%ZZ-mesh_100000000001-oep_100000000001.jsonl'),
      isMeshFixtureCaptureFileName('-mesh_100000000001-oep_100000000001.jsonl'),
      isMeshFixtureCaptureFileName('codex-mes_100000000001-oep_100000000001.jsonl'),
      isMeshFixtureCaptureFileName('codex-mesh_100000000001-ope_100000000001.jsonl'),
      isMeshFixtureCaptureFileName('codex-mesh_short-oep_100000000001.jsonl'),
      isMeshFixtureCaptureFileName('human-notes.jsonl'),
      isMeshFixtureCaptureFileName(
        '.codex-mesh_100000000001-oep_100000000001.jsonl.123e4567-e89b-42d3-a456-426614174000.tmp'
      )
    ],
    temporary: [
      isMeshFixtureCaptureTempFileName(
        '.codex-mesh_100000000001-oep_100000000001.jsonl.123e4567-e89b-42d3-a456-426614174000.tmp'
      ),
      isMeshFixtureCaptureTempFileName(
        '.codex-mesh_100000000001-oep_100000000001.jsonl.123e4567-e89b-12d3-a456-426614174000.tmp'
      ),
      isMeshFixtureCaptureTempFileName(
        '.codex-mesh_100000000001-oep_100000000001.jsonl.123e4567-e89b-42d3-7456-426614174000.tmp'
      ),
      isMeshFixtureCaptureTempFileName('codex-mesh_100000000001-oep_100000000001.jsonl'),
      isMeshFixtureCaptureTempFileName('.unrelated.tmp')
    ]
  }).toEqual({
    writerOutput: [true, true, true, true, true, true],
    leadingDotTemp: true,
    uppercaseSyntax: [false, false, false, false, false],
    lookalikes: [false, false, false, false, false, false, false, false, false, false, false, false],
    temporary: [true, false, false, false, false]
  });
});

test('a failed atomic rename leaves only a private temp and never reports a final capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monad-fixture-tap-'));
  directories.push(directory);
  const records: LoggerRecord[] = [];
  configureLogger({
    destinations: [
      {
        type: 'custom',
        name: 'fixture-tap-rename-failure',
        level: 'debug',
        write(record) {
          records.push(record);
        }
      }
    ]
  });
  const tap = new MeshFixtureTap(directory, createLogger('mesh-fixture-tap-test'), 500, {
    async rename() {
      throw new Error('injected rename failure');
    }
  });

  tap.record(frame('{"type":"session_meta","payload":{}}\n'));
  await tap.flush(MESH_SESSION_ID, FIRST_EPOCH);

  const files = await readdir(directory);
  const temp = files[0];
  if (!temp) throw new Error('capture did not leave its temporary file');
  expect({
    fileCount: files.length,
    ...(process.platform === 'win32' ? {} : { mode: (await stat(join(directory, temp))).mode & 0o777 }),
    matchesTemp: isMeshFixtureCaptureTempFileName(temp),
    matchesFinal: files.some(isMeshFixtureCaptureFileName),
    reported: records.map((record) => ({
      event: record.event,
      basename: record.basename,
      path: record.path,
      err: record.err
    }))
  }).toEqual({
    fileCount: 1,
    ...(process.platform === 'win32' ? {} : { mode: 0o600 }),
    matchesTemp: true,
    matchesFinal: false,
    reported: [{ event: 'mesh.fixture_capture_error', basename: undefined, path: undefined, err: { name: 'Error' } }]
  });
});
