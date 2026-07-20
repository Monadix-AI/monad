import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@monad/logger';

import { MeshFixtureTap } from '#/services/mesh-agent/fixture-tap.ts';

const log = createLogger('mesh-fixture-tap-test');
const directories: string[] = [];

afterEach(async () => {
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
    meshSessionId: 'mes_tap1',
    observationEpoch: over.epoch ?? 'oep_1',
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
  await tap.flush('mes_tap1', 'oep_1');

  const { name, text, records } = await readFixture(directory);
  expect({ name, text, records }).toEqual({
    name: 'codex-mes_tap1-oep_1.jsonl',
    text: '{"type":"event_msg","payload":{"type":"agent_message","message":"ship it"}}\n',
    records: [{ type: 'event_msg', payload: { type: 'agent_message', message: 'ship it' } }]
  });
});

test('capture preserves real paths and secrets and writes owner-only', async () => {
  const { directory, tap } = await tapWith();

  tap.record(frame('{"type":"turn_context","payload":{"cwd":"/Users/zeke/secret-repo","api_key":"sk-live-abc123"}}\n'));
  await tap.flush('mes_tap1', 'oep_1');

  const { name, records } = await readFixture(directory);
  const mode = (await stat(join(directory, name))).mode & 0o777;
  // Verbatim on purpose: redaction is the promotion step's job (scripts/mesh-fixture.ts), so the
  // on-disk capture must still be exactly what the provider emitted.
  expect({ mode, record: records[0] }).toEqual({
    mode: 0o600,
    record: { type: 'turn_context', payload: { cwd: '/Users/zeke/secret-repo', api_key: 'sk-live-abc123' } }
  });
});

test('an incomplete trailing frame is held back rather than written as a broken record', async () => {
  const { directory, tap } = await tapWith();

  tap.record(frame('{"type":"session_meta","payload":{}}\n{"type":"turn_conte'));
  await tap.flush('mes_tap1', 'oep_1');

  const { records } = await readFixture(directory);
  expect(records).toEqual([{ type: 'session_meta', payload: {} }]);
});

test('capture stops at maxRecords and ignores stderr', async () => {
  const { directory, tap } = await tapWith(2);

  for (let index = 0; index < 5; index++) tap.record(frame(`{"type":"event_msg","payload":{"index":${index}}}\n`));
  tap.record(frame('{"type":"event_msg","payload":{"index":99}}\n', { stream: 'stderr' }));
  await tap.flush('mes_tap1', 'oep_1');

  const { records } = await readFixture(directory);
  expect(records.map((record: { payload: { index: number } }) => record.payload.index)).toEqual([0, 1]);
});

test('each observation epoch flushes to its own capture file', async () => {
  const { directory, tap } = await tapWith();

  tap.record(frame('{"type":"event_msg","payload":{"epoch":1}}\n', { epoch: 'oep_1' }));
  tap.record(frame('{"type":"event_msg","payload":{"epoch":2}}\n', { epoch: 'oep_2' }));
  await tap.flush('mes_tap1', 'oep_1');
  await tap.flush('mes_tap1', 'oep_2');

  const files = (await readdir(directory)).sort();
  const payloads = await Promise.all(
    files.map(async (name) => JSON.parse(await Bun.file(join(directory, name)).text()).payload)
  );
  expect({ files, payloads }).toEqual({
    files: ['codex-mes_tap1-oep_1.jsonl', 'codex-mes_tap1-oep_2.jsonl'],
    payloads: [{ epoch: 1 }, { epoch: 2 }]
  });
});

test('a flush with no complete frame writes nothing', async () => {
  const { directory, tap } = await tapWith();

  tap.record(frame('{"type":"event_msg","payl'));
  await tap.flush('mes_tap1', 'oep_1');

  expect(await readdir(directory)).toEqual([]);
});
