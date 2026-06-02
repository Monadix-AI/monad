import type { MeshAgentObservationProjector } from '@monad/sdk-atom';
import type { Turn as CodexThreadTurn } from '../../generated/codex-app-server/ts/v2/Turn.ts';

import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  codexEventPageOutput,
  createCodexEventSource,
  readCodexEventPage
} from '../../src/agent-adapters/codex/event-pages.ts';
import { codexObservationProjection } from '../../src/agent-adapters/codex/observation/index.ts';
import { readProviderEventFile } from '../../src/agent-adapters/event-files.ts';
import { createOutputEventSource } from '../../src/agent-adapters/event-source.ts';
import { multiTurnObservationFixtureSchema } from '../../src/agent-adapters/observation-fixture.ts';
import { openClawHistoryRecords } from '../../src/agent-adapters/openclaw/event-pages.ts';

const directories: string[] = [];
const projection = { recordProjectors: [] } as unknown as MeshAgentObservationProjector;
const context = { providerSessionRef: 'session-lines', workingPath: '/tmp/project' };
const codexAppServerTurn = {
  id: 'turn_1',
  items: [{ type: 'agentMessage', id: 'msg_1', text: 'from app-server', phase: null, memoryCitation: null }],
  itemsView: 'full',
  status: 'completed',
  error: null,
  startedAt: 1_784_000_000,
  completedAt: 1_784_000_005,
  durationMs: 1000
};
const codexAppServerSecondTurn = {
  ...codexAppServerTurn,
  id: 'turn_2',
  items: [{ type: 'agentMessage', id: 'msg_2', text: 'second turn', phase: null, memoryCitation: null }]
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fixtureCodexTurns(
  turns: ReturnType<typeof multiTurnObservationFixtureSchema.parse>['turns']
): CodexThreadTurn[] {
  return turns.map((turn, turnIndex) => {
    const items: CodexThreadTurn['items'] = turn.records.flatMap((record) => {
      const data = objectValue(record.data);
      const item = data?.type === 'item.completed' ? objectValue(data.item) : undefined;
      if (item?.type !== 'agent_message' || typeof item.id !== 'string' || typeof item.text !== 'string') return [];
      return [{ type: 'agentMessage', id: item.id, text: item.text, phase: null, memoryCitation: null }];
    });
    return {
      id: `fixture-turn-${turnIndex}`,
      items,
      itemsView: 'full',
      status: 'completed',
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null
    };
  });
}

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

test('OpenClaw history reads from the configured provider state directory', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'monad-openclaw-state-'));
  directories.push(stateRoot);
  const sessionsDirectory = join(stateRoot, 'agents', 'main', 'sessions');
  mkdirSync(sessionsDirectory, { recursive: true });
  writeFileSync(
    join(sessionsDirectory, 'sessions.json'),
    JSON.stringify({ 'agent:main:thread': { sessionId: 'history-session' } })
  );
  const record = { type: 'message', message: { role: 'assistant', content: 'from configured state' } };
  writeFileSync(join(sessionsDirectory, 'history-session.jsonl'), JSON.stringify(record));

  expect(
    await openClawHistoryRecords({
      providerSessionRef: 'agent:main:thread',
      workingPath: '/tmp/project',
      env: { OPENCLAW_STATE_DIR: stateRoot }
    })
  ).toEqual([record]);
});

test('codex native page history is translated into individual event records', () => {
  const output = codexEventPageOutput({
    ...context,
    page: { items: [codexAppServerTurn, codexAppServerSecondTurn] }
  });

  expect(output).toBe([codexAppServerTurn, codexAppServerSecondTurn].map((turn) => JSON.stringify(turn)).join('\n'));
});

test('standalone Codex thread turns retain turn boundaries and second-based timestamps', () => {
  const output = codexEventPageOutput({
    ...context,
    page: { items: [codexAppServerTurn, codexAppServerSecondTurn] }
  });
  if (!output) throw new Error('expected translated Codex turns');
  const source = createOutputEventSource({
    provider: 'codex',
    projection: codexObservationProjection,
    readOutput: () => output
  });

  expect(source.projectLive({ id: 'thread-from-app-server', output, mode: 'events' }).events).toEqual([
    expect.objectContaining({
      createdAt: '2026-07-14T03:33:20.000Z',
      providerEventType: 'turn-start',
      text: 'Turn started'
    }),
    expect.objectContaining({ providerEventType: 'item/agentMessage', text: 'from app-server' }),
    expect.objectContaining({
      createdAt: '2026-07-14T03:33:25.000Z',
      providerEventType: 'turn-end',
      text: 'Turn completed'
    }),
    expect.objectContaining({
      createdAt: '2026-07-14T03:33:20.000Z',
      providerEventType: 'turn-start',
      text: 'Turn started'
    }),
    expect.objectContaining({ providerEventType: 'item/agentMessage', text: 'second turn' }),
    expect.objectContaining({
      createdAt: '2026-07-14T03:33:25.000Z',
      providerEventType: 'turn-end',
      text: 'Turn completed'
    })
  ]);
});

test('Codex app-server history reads fixture-derived native turns once in chronological page order', async () => {
  const fixture = multiTurnObservationFixtureSchema.parse(
    await Bun.file(new URL('../fixtures/mesh-agent-observation/codex-multi-turn.raw.json', import.meta.url)).json()
  );
  const directory = mkdtempSync(join(tmpdir(), 'monad-codex-fixture-history-'));
  directories.push(directory);
  const turns = fixtureCodexTurns(fixture.turns);
  const calls: unknown[] = [];
  const context = { providerSessionRef: 'fixture-thread', workingPath: directory };

  const page = await readCodexEventPage(
    {
      ...context,
      request: { limit: turns.length, sortDirection: 'desc', itemsView: 'full' }
    },
    {
      pageRead: async (readContext) => {
        calls.push(readContext);
        return { data: [...turns].reverse(), nextCursor: null };
      }
    }
  );
  const output = codexEventPageOutput({ ...context, page });
  if (!output) throw new Error('expected Codex fixture history output');
  const outputTurns = output.split('\n').map((line) => JSON.parse(line));

  expect({
    outputUnchanged: JSON.stringify(outputTurns) === JSON.stringify(turns),
    outputTurnCount: outputTurns.length,
    sourceTurnCount: turns.length,
    sourceItemCounts: turns.map((turn) => turn.items.length),
    calls
  }).toEqual({
    outputUnchanged: true,
    outputTurnCount: fixture.turns.length,
    sourceTurnCount: fixture.turns.length,
    sourceItemCounts: [52, 2, 16, 2],
    calls: [
      {
        ...context,
        request: { limit: turns.length, sortDirection: 'desc', itemsView: 'full' }
      }
    ]
  });
});

test('Codex history uses native app-server cursor pagination', async () => {
  const calls: unknown[] = [];
  const source = createCodexEventSource({
    pageRead: async (pageContext) => {
      calls.push(pageContext);
      if (!pageContext.request.before) {
        return {
          data: [codexAppServerSecondTurn, codexAppServerTurn],
          nextCursor: 'opaque:older'
        };
      }
      return {
        data: [{ ...codexAppServerTurn, id: 'turn_0' }],
        nextCursor: null
      };
    }
  });
  const readPage = source.readPage;
  if (!readPage) throw new Error('expected Codex provider event paging');

  const first = await readPage(context, { view: 'raw', limit: 2 });
  const second = await readPage(context, { view: 'raw', before: 'opaque:older', limit: 2 });

  expect({ calls, first, second }).toEqual({
    calls: [
      {
        ...context,
        request: { limit: 2, sortDirection: 'desc', itemsView: 'full' }
      },
      {
        ...context,
        request: { before: 'opaque:older', limit: 2, sortDirection: 'desc', itemsView: 'full' }
      }
    ],
    first: {
      state: 'available',
      view: 'raw',
      records: [
        { data: codexAppServerTurn, cursor: 'turn_1', providerIdentity: 'turn_1' },
        { data: codexAppServerSecondTurn, cursor: 'turn_2', providerIdentity: 'turn_2' }
      ],
      coverage: 'settled',
      nextCursor: 'opaque:older'
    },
    second: {
      state: 'available',
      view: 'raw',
      records: [
        {
          data: { ...codexAppServerTurn, id: 'turn_0' },
          cursor: 'turn_0',
          providerIdentity: 'turn_0'
        }
      ],
      coverage: 'settled'
    }
  });
});

test('Codex native history opts into the experimental app-server API', async () => {
  const writes: string[] = [];
  const response = `${JSON.stringify({
    id: 2,
    result: {
      data: [codexAppServerSecondTurn, codexAppServerTurn],
      nextCursor: 'opaque:next',
      backwardsCursor: 'opaque:newer'
    }
  })}\n`;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(response));
      controller.close();
    }
  });

  const page = await readCodexEventPage(
    {
      ...context,
      providerSessionRef: 'thread-app-server',
      request: { limit: 2, sortDirection: 'desc', itemsView: 'full' }
    },
    {
      command: '/fake/codex',
      spawn: () => ({
        stdin: { write: (chunk: string) => writes.push(chunk) },
        stdout,
        kill() {}
      })
    }
  );

  expect({
    requests: writes.flatMap((chunk) =>
      chunk
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    ),
    page
  }).toEqual({
    requests: [
      {
        method: 'initialize',
        id: 1,
        params: {
          clientInfo: { name: 'monad', version: '0' },
          capabilities: { experimentalApi: true }
        }
      },
      { method: 'initialized' },
      {
        method: 'thread/turns/list',
        id: 2,
        params: {
          threadId: 'thread-app-server',
          limit: 2,
          sortDirection: 'desc',
          itemsView: 'full'
        }
      }
    ],
    page: {
      items: [codexAppServerTurn, codexAppServerSecondTurn],
      nextCursor: 'opaque:next'
    }
  });
});

test('Codex app-server failure makes history temporarily unavailable', async () => {
  const source = createCodexEventSource({
    pageRead: async () => {
      throw new Error('app-server failed');
    }
  });
  const readPage = source.readPage;
  if (!readPage) throw new Error('expected Codex provider event paging');

  expect(await readPage(context, { view: 'convenience', limit: 20 })).toEqual({
    state: 'unavailable',
    reason: 'temporary'
  });
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
