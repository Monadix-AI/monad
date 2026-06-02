import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createAgent } from '@/agent/index.ts';
import { createStore } from '@/store/db/index.ts';

// E2E: agent-core wired to a real Store (bun:sqlite in-memory). Validates that the
// session repo interface is honoured end-to-end rather than just with a hand-rolled mock.

test('session created via agent is retrievable from the real store', async () => {
  const store = createStore(); // bun:sqlite :memory:
  const agent = createAgent({
    sessionRepo: {
      insertSession: (s) => store.insertSession(s),
      getSession: (id) => store.getSession(id)
    }
  });

  const session = await agent.sessions.create('e2e session', newId('prn'));

  const found = store.getSession(session.id);
  expect(found).not.toBeNull();
  expect(found?.title).toBe('e2e session');
  expect(found?.state).toBe('active');
  store.close();
});

test('multiple sessions accumulate in the store independently', async () => {
  const store = createStore();
  const repo = {
    insertSession: (s: Parameters<typeof store.insertSession>[0]) => store.insertSession(s),
    getSession: (id: string) => store.getSession(id)
  };

  const agent = createAgent({ sessionRepo: repo });
  const owner = newId('prn');

  const s1 = await agent.sessions.create('first', owner);
  const s2 = await agent.sessions.create('second', owner);

  expect(store.getSession(s1.id)?.title).toBe('first');
  expect(store.getSession(s2.id)?.title).toBe('second');
  // ids are distinct
  expect(s1.id).not.toBe(s2.id);
  store.close();
});
