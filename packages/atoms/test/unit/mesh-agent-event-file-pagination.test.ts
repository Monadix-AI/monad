import type { MeshAgentObservationProjector } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readProviderEventFile } from '../../src/agent-adapters/event-files.ts';
import { createOutputEventSource } from '../../src/agent-adapters/event-source.ts';

const directories: string[] = [];
const projection = { recordProjectors: [] } as unknown as MeshAgentObservationProjector;
const context = { providerSessionRef: 'session-lines', workingPath: '/tmp/project' };

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
