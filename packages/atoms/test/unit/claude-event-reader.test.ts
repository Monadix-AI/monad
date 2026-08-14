import type { GetSessionMessagesOptions, SessionMessage } from '@anthropic-ai/claude-agent-sdk';

import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClaudeEventSource } from '../../src/agent-adapters/claude-code/event-pages.ts';
import {
  createClaudeSdkEventPageReader,
  createClaudeSdkHistoryOutputReader
} from '../../src/agent-adapters/claude-code/index.ts';
import { multiTurnObservationFixtureSchema } from '../../src/agent-adapters/observation-fixture.ts';

const directories: string[] = [];

function sessionMessage(value: unknown): SessionMessage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (!('type' in value) || (value.type !== 'user' && value.type !== 'assistant' && value.type !== 'system'))
    return undefined;
  if (!('uuid' in value) || typeof value.uuid !== 'string') return undefined;
  if (!('session_id' in value) || typeof value.session_id !== 'string') return undefined;
  if (!('message' in value) || !('parent_tool_use_id' in value)) return undefined;
  if (value.parent_tool_use_id !== null && typeof value.parent_tool_use_id !== 'string') return undefined;
  const parentAgentId = 'parent_agent_id' in value ? value.parent_agent_id : undefined;
  if (parentAgentId !== undefined && parentAgentId !== null && typeof parentAgentId !== 'string') return undefined;
  return {
    type: value.type,
    uuid: value.uuid,
    session_id: value.session_id,
    message: value.message,
    parent_tool_use_id: value.parent_tool_use_id,
    parent_agent_id: typeof parentAgentId === 'string' ? parentAgentId : null
  };
}

function sessionMessages(values: readonly unknown[]): SessionMessage[] {
  return values.flatMap((value) => {
    const message = sessionMessage(value);
    return message ? [message] : [];
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('Claude SDK history keeps the native session start when the transcript is long', async () => {
  const calls: unknown[] = [];
  const reader = createClaudeSdkHistoryOutputReader({
    getSessionMessages: (async (...args: unknown[]) => {
      calls.push(args);
      return [
        {
          type: 'user',
          uuid: 'message-start',
          session_id: 'claude-session',
          message: { role: 'user', content: 'native session start' },
          parent_tool_use_id: null
        },
        {
          type: 'assistant',
          uuid: 'message-latest',
          session_id: 'claude-session',
          message: { role: 'assistant', content: [{ type: 'text', text: 'latest reply' }] },
          parent_tool_use_id: null
        }
      ];
    }) as never
  });

  expect(
    await reader({
      providerSessionRef: 'claude-session',
      workingPath: '/tmp/project'
    })
  ).toEqual(
    [
      {
        type: 'user',
        uuid: 'message-start',
        session_id: 'claude-session',
        message: { role: 'user', content: 'native session start' },
        parent_tool_use_id: null
      },
      {
        type: 'assistant',
        uuid: 'message-latest',
        session_id: 'claude-session',
        message: { role: 'assistant', content: [{ type: 'text', text: 'latest reply' }] },
        parent_tool_use_id: null
      }
    ]
      .map((message) => JSON.stringify(message))
      .join('\n')
  );
  expect(calls).toEqual([
    [
      'claude-session',
      {
        dir: '/tmp/project',
        includeSystemMessages: true
      }
    ]
  ]);
});

test('Claude SDK history contains only provider-returned messages', async () => {
  const reader = createClaudeSdkEventPageReader({
    getSessionMessages: (async () => [
      {
        type: 'assistant',
        uuid: 'message-1',
        session_id: 'claude-session',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        parent_tool_use_id: null
      }
    ]) as never
  });

  expect(
    await reader({
      providerSessionRef: 'claude-session',
      workingPath: '/tmp/project',
      request: { limit: 20, sortDirection: 'desc', itemsView: 'full' }
    })
  ).toEqual({
    items: [
      {
        type: 'assistant',
        uuid: 'message-1',
        session_id: 'claude-session',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        parent_tool_use_id: null
      }
    ]
  });
});

test('Claude SDK history preserves structured file patches in output and pages', async () => {
  const toolUseResult = {
    filePath: '/workspace/src/index.ts',
    structuredPatch: [
      {
        oldStart: 32,
        oldLines: 1,
        newStart: 32,
        newLines: 1,
        lines: ['-const state = false;', '+const state = true;']
      }
    ]
  };
  const message = {
    type: 'user',
    uuid: 'message-tool-result',
    session_id: 'claude-session',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_Edit', content: 'Completed.' }]
    },
    parent_tool_use_id: null,
    tool_use_result: toolUseResult
  } as unknown as SessionMessage;
  const getSessionMessages = (async () => [message]) as never;
  const outputReader = createClaudeSdkHistoryOutputReader({ getSessionMessages });
  const pageReader = createClaudeSdkEventPageReader({ getSessionMessages });
  const context = { providerSessionRef: 'claude-session', workingPath: '/tmp/project' };

  const output = await outputReader(context);
  const page = await pageReader({
    ...context,
    request: { limit: 20, sortDirection: 'desc', itemsView: 'full' }
  });

  const expected = {
    type: 'user',
    uuid: 'message-tool-result',
    session_id: 'claude-session',
    message: message.message,
    parent_tool_use_id: null,
    tool_use_result: toolUseResult
  };
  expect({ output: output ? JSON.parse(output) : null, page }).toEqual({
    output: expected,
    page: { items: [expected] }
  });
});

test('Claude SDK fixture history starts at the latest window and pages backward in chronological chunks', async () => {
  const fixture = multiTurnObservationFixtureSchema.parse(
    await Bun.file(
      new URL('../fixtures/mesh-agent-observation/claude-code-multi-turn.raw.json', import.meta.url)
    ).json()
  );
  const messages = sessionMessages(fixture.turns.flatMap((turn) => turn.records.map((record) => record.data)));
  const root = mkdtempSync(join(tmpdir(), 'monad-claude-fixture-history-'));
  directories.push(root);
  const sessionDirectory = join(root, 'sessions');
  mkdirSync(sessionDirectory);
  const sessionId = 'fixture-claude-session';
  writeFileSync(
    join(sessionDirectory, `${sessionId}.jsonl`),
    messages.map((message) => JSON.stringify(message)).join('\n')
  );
  const calls: unknown[] = [];
  const getSessionMessages = async (
    requestedSessionId: string,
    options: GetSessionMessagesOptions = {}
  ): Promise<SessionMessage[]> => {
    calls.push([requestedSessionId, options]);
    if (!options.dir) throw new Error('expected an isolated Claude session directory');
    const stored = sessionMessages(
      readFileSync(join(options.dir, `${requestedSessionId}.jsonl`), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    );
    const offset = options.offset ?? 0;
    return stored.slice(offset, options.limit === undefined ? undefined : offset + options.limit);
  };
  const readOutput = createClaudeSdkHistoryOutputReader({ getSessionMessages });
  const readPage = createClaudeSdkEventPageReader({ getSessionMessages });
  const context = { providerSessionRef: sessionId, workingPath: sessionDirectory };

  const output = await readOutput(context);
  if (!output) throw new Error('expected Claude fixture history output');
  const pages = [];
  let before: string | undefined;
  do {
    const page = await readPage({
      ...context,
      request: { before, limit: 20, sortDirection: 'desc', itemsView: 'full' }
    });
    if (!page) throw new Error('expected Claude fixture history page');
    pages.push(page);
    before = page.nextCursor;
  } while (before);

  const expectedItems = messages.map((message) => ({
    ...message
  }));
  const outputItems = output.split('\n').map((line) => JSON.parse(line));
  const pagedItems = pages.flatMap((page) => page.items);
  const expectedPages = [messages.slice(55), messages.slice(35, 55), messages.slice(15, 35), messages.slice(0, 15)];
  expect({
    outputUnchanged: JSON.stringify(outputItems) === JSON.stringify(expectedItems),
    pagesNewestFirst: JSON.stringify(pages.map((page) => page.items)) === JSON.stringify(expectedPages),
    outputCount: outputItems.length,
    pagedCount: pagedItems.length,
    sourceCount: expectedItems.length,
    sourceTypeCounts: messages.reduce<Record<string, number>>((counts, message) => {
      counts[message.type] = (counts[message.type] ?? 0) + 1;
      return counts;
    }, {}),
    pageCursors: pages.map((page) => page.nextCursor ?? null),
    calls
  }).toEqual({
    outputUnchanged: true,
    pagesNewestFirst: true,
    outputCount: 75,
    pagedCount: 75,
    sourceCount: 75,
    sourceTypeCounts: { assistant: 43, user: 32 },
    pageCursors: ['55', '35', '15', null],
    calls: [
      [sessionId, { dir: sessionDirectory, includeSystemMessages: true }],
      [sessionId, { dir: sessionDirectory, includeSystemMessages: true }],
      [sessionId, { dir: sessionDirectory, limit: 20, offset: 35, includeSystemMessages: true }],
      [sessionId, { dir: sessionDirectory, limit: 20, offset: 15, includeSystemMessages: true }],
      [sessionId, { dir: sessionDirectory, limit: 15, offset: 0, includeSystemMessages: true }]
    ]
  });
});

test('Claude provider-native event source serves raw and convenience pages from the same latest window', async () => {
  const messages = Array.from({ length: 3 }, (_, index) => ({
    type: index === 0 ? ('user' as const) : ('assistant' as const),
    uuid: `message-${index}`,
    session_id: 'claude-session',
    message: {
      role: index === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `message ${index}` }]
    },
    parent_tool_use_id: null,
    parent_agent_id: null
  }));
  const source = createClaudeEventSource({ getSessionMessages: (async () => messages) as never });
  const context = { providerSessionRef: 'claude-session', workingPath: '/tmp/project' };

  const [raw, convenience] = await Promise.all([
    source.readPage?.(context, { view: 'raw', limit: 2 }),
    source.readPage?.(context, { view: 'convenience', limit: 2 })
  ]);

  expect({
    raw,
    convenience:
      convenience?.state === 'available' && convenience.view === 'convenience'
        ? {
            nextCursor: convenience.nextCursor,
            events: convenience.events.map(({ role, text }) => ({ role, text }))
          }
        : convenience
  }).toEqual({
    raw: {
      state: 'available',
      view: 'raw',
      records: messages.slice(1).map((data) => ({
        data,
        cursor: data.uuid,
        providerIdentity: data.uuid
      })),
      coverage: 'settled',
      nextCursor: '1'
    },
    convenience: {
      nextCursor: '1',
      events: [
        { role: 'agent', text: 'message 1' },
        { role: 'agent', text: 'message 2' }
      ]
    }
  });
});
