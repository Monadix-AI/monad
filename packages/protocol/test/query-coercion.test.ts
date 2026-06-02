import { expect, test } from 'bun:test';

import { daemonHttpContract } from '../src/http.ts';

test('sessions.list query: string→boolean and string→number coercion', () => {
  const q = daemonHttpContract.sessions.list.query ?? '';
  expect(q.parse({ archived: 'true', limit: '10' })).toMatchObject({ archived: true, limit: 10 });
  expect(q.parse({ archived: 'false', offset: '0' })).toMatchObject({ archived: false, offset: 0 });
  expect(q.parse({ limit: '5', offset: '2' })).toMatchObject({ limit: 5, offset: 2 });
  expect(q.safeParse({ archived: 'notabool' }).success).toBe(false);
});

test('sessions.messages query: boolean coercion', () => {
  const q = daemonHttpContract.sessions.messages.query ?? '';
  expect(q.parse({ includeInactive: 'true', limit: '5' })).toMatchObject({
    includeInactive: true,
    limit: 5
  });
});

test('sessions.search query: q defaults to empty string, limit coerced', () => {
  const q = daemonHttpContract.sessions.search.query ?? '';
  const empty = q.parse({}) as { q: string };
  expect(empty.q).toBe('');
  expect(q.parse({ q: 'hello', limit: '20' })).toMatchObject({ q: 'hello', limit: 20 });
});
