import type { MeshAgentObservationProjector } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { codexThreadReadOutput, readCodexEventOutput } from '../../src/agent-adapters/codex/event-pages.ts';
import { readProviderEventFile } from '../../src/agent-adapters/event-files.ts';
import { createOutputEventSource } from '../../src/agent-adapters/event-source.ts';

const directories: string[] = [];
const projection = { recordProjectors: [] } as unknown as MeshAgentObservationProjector;
const context = { providerSessionRef: 'session-lines', workingPath: '/tmp/project' };
const codexAppServerTurn = {
  id: 'turn_1',
  items: [{ type: 'agentMessage', id: 'msg_1', text: 'from app-server', phase: null, memoryCitation: null }],
  itemsView: 'full',
  status: 'completed',
  error: null,
  startedAt: 1,
  completedAt: 2,
  durationMs: 1000
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('provider event history is not truncated by a byte snapshot limit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'monad-event-lines-'));
  directories.push(directory);
  const records = [
    { id: 'first', text: 'x'.repeat(128) },
    { id: 'second', text: 'latest' }
  ];
  writeFileSync(join(directory, 'session-lines.jsonl'), records.map((record) => JSON.stringify(record)).join('\n'));

  expect(
    readProviderEventFile({
      roots: [directory],
      providerSessionRef: 'session-lines',
      extensions: ['.jsonl']
    })
  ).toBe(records.map((record) => JSON.stringify(record)).join('\n'));
});

test('codex history reads from the configured archived sessions home', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'monad-codex-home-'));
  directories.push(codexHome);
  const archiveDirectory = join(codexHome, 'archived_sessions');
  mkdirSync(archiveDirectory);
  const output = JSON.stringify({ type: 'session_meta', payload: { id: 'thread-custom' } });
  writeFileSync(join(archiveDirectory, 'rollout-thread-custom.jsonl'), output);

  expect(
    await readCodexEventOutput(
      { providerSessionRef: 'thread-custom', workingPath: '/tmp/project' },
      { env: { CODEX_HOME: codexHome }, threadRead: async () => null }
    )
  ).toBe(output);
});

test('codex history prefers translated app-server thread reads over file fallback', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'monad-codex-home-'));
  directories.push(codexHome);
  const archiveDirectory = join(codexHome, 'archived_sessions');
  mkdirSync(archiveDirectory);
  writeFileSync(
    join(archiveDirectory, 'rollout-thread-app-server.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-app-server' } })
  );

  const output = await readCodexEventOutput(
    { providerSessionRef: 'thread-app-server', workingPath: '/tmp/project' },
    {
      env: { CODEX_HOME: codexHome },
      threadRead: async () => ({
        thread: {
          id: 'thread-app-server',
          turns: [codexAppServerTurn]
        }
      })
    }
  );

  expect(output).toBe(
    JSON.stringify({
      result: {
        data: [codexAppServerTurn],
        nextCursor: null,
        backwardsCursor: null
      }
    })
  );
});

test('codex thread read history is translated into a turns page output', () => {
  const output = codexThreadReadOutput({
    thread: {
      id: 'thread-from-app-server',
      turns: [codexAppServerTurn]
    }
  });

  expect(output).toBe(
    JSON.stringify({
      result: {
        data: [codexAppServerTurn],
        nextCursor: null,
        backwardsCursor: null
      }
    })
  );
});

test('line cursors remain stable when the provider file grows between pages', async () => {
  let records = Array.from({ length: 6 }, (_, index) => ({ id: `record-${index}`, text: `${index}` }));
  const source = createOutputEventSource({
    provider: 'codex',
    projection,
    readOutput: () => records.map((record) => JSON.stringify(record)).join('\n')
  });
  const readPage = source.readPage;
  if (!readPage) throw new Error('expected provider event paging');

  const first = await readPage(context, { view: 'raw', limit: 2 });
  records = [...records, { id: 'record-6', text: '6' }, { id: 'record-7', text: '7' }];
  const second = await readPage(context, { view: 'raw', before: 'line:4', limit: 2 });
  const third = await readPage(context, { view: 'raw', before: 'line:2', limit: 2 });

  expect([first, second, third]).toEqual([
    {
      state: 'available',
      view: 'raw',
      records: [
        { data: { id: 'record-4', text: '4' }, cursor: 'record-4', providerIdentity: 'record-4' },
        { data: { id: 'record-5', text: '5' }, cursor: 'record-5', providerIdentity: 'record-5' }
      ],
      coverage: 'settled',
      nextCursor: 'line:4'
    },
    {
      state: 'available',
      view: 'raw',
      records: [
        { data: { id: 'record-2', text: '2' }, cursor: 'record-2', providerIdentity: 'record-2' },
        { data: { id: 'record-3', text: '3' }, cursor: 'record-3', providerIdentity: 'record-3' }
      ],
      coverage: 'settled',
      nextCursor: 'line:2'
    },
    {
      state: 'available',
      view: 'raw',
      records: [
        { data: { id: 'record-0', text: '0' }, cursor: 'record-0', providerIdentity: 'record-0' },
        { data: { id: 'record-1', text: '1' }, cursor: 'record-1', providerIdentity: 'record-1' }
      ],
      coverage: 'settled'
    }
  ]);
});
