import type { Session } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createAgent } from '@/agent/index.ts';

test('createAgent with mock repo creates a session in the active state', async () => {
  const saved: Session[] = [];
  const agent = createAgent({
    sessionRepo: {
      insertSession: (s) => {
        saved.push(s);
      },
      getSession: () => null
    }
  });

  const session = await agent.sessions.create('hello', newId('prn'));

  expect(session.state).toBe('active');
  expect(session.id).toMatch(/^ses_/);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toEqual(session);
});

test('createAgent starts with no tools when none provided', () => {
  const agent = createAgent({
    sessionRepo: { insertSession: () => {}, getSession: () => null }
  });
  expect(agent.tools).toEqual([]);
});

test('createAgent passes through provided tools', () => {
  const fakeTool = { name: 'x', description: 'x', scopes: [], run: async () => {} };
  const agent = createAgent({
    tools: [fakeTool as never],
    sessionRepo: { insertSession: () => {}, getSession: () => null }
  });
  expect(agent.tools).toHaveLength(1);
  expect(agent.tools[0]?.name).toBe('x');
});
