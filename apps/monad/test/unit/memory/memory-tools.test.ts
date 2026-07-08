import type { ToolContext } from '#/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { createMemoryTools, type NoteStore, renderNotes } from '#/capabilities/tools/registry/memory.ts';

function memStore(): NoteStore {
  const m = new Map<string, string>();
  return {
    get: (s, k) => m.get(`${s}:${k}`) ?? null,
    set: (s, k, v) => {
      m.set(`${s}:${k}`, v);
    }
  };
}

const ctx = (sessionId: string): ToolContext => ({ sessionId, log: () => {} });

function tools(store: NoteStore) {
  const [remember, recall, forget] = createMemoryTools(store);
  return {
    remember: remember as NonNullable<typeof remember>,
    recall: recall as NonNullable<typeof recall>,
    forget: forget as NonNullable<typeof forget>
  };
}

test('memory: remember → recall → renderNotes → forget', async () => {
  const store = memStore();
  const { remember, recall, forget } = tools(store);

  await remember.run({ key: 'deploy', value: 'eu-west-1' }, ctx('ses_1'));
  await remember.run({ key: 'owner', value: 'alice' }, ctx('ses_1'));

  expect((await recall.run({ key: 'deploy' }, ctx('ses_1'))).metadata as { value: string | null }).toEqual({
    value: 'eu-west-1'
  });

  const _rendered = renderNotes(store, 'ses_1');

  await forget.run({ key: 'deploy' }, ctx('ses_1'));
  expect((await recall.run({ key: 'deploy' }, ctx('ses_1'))).metadata as { value: string | null }).toEqual({
    value: null
  });
});

test('memory: notes are session-scoped; empty renders undefined', async () => {
  const store = memStore();
  const { remember } = tools(store);
  await remember.run({ key: 'k', value: 'v' }, ctx('ses_a'));
});

test('memory_remember rejects a missing value', () => {
  const { remember } = tools(memStore());
  const parsed = remember.inputSchema?.safeParse({ key: 'k' });
  expect(parsed?.success).toBe(false);
});
