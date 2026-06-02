// Locks the multi-transport query contract: the RPC transports validate against the canonical
// control.ts query schemas, and the HTTP transport validates against a coercified view of the
// SAME schema. Constraints (`.max()`, `.positive()`) therefore hold identically on both, and a
// hand-copied HTTP query that silently drops a constraint (the bug this guards) fails here.

import { expect, test } from 'bun:test';

import {
  listMessagesQuerySchema,
  listSessionsQuerySchema,
  listSkillsQuerySchema,
  SEARCH_QUERY_MAX,
  searchSessionsRequestSchema
} from '../src/control.ts';
import { daemonHttpContract } from '../src/http.ts';
import { METHOD_TABLE } from '../src/method-table.ts';

test('RPC query schemas ARE the canonical control.ts schemas (no inline copy)', () => {
  expect((METHOD_TABLE['sessions.search'] as { query: unknown }).query).toBe(searchSessionsRequestSchema);
  expect((METHOD_TABLE['sessions.list'] as { query: unknown }).query).toBe(listSessionsQuerySchema);
  expect((METHOD_TABLE['sessions.messages'] as { query: unknown }).query).toBe(listMessagesQuerySchema);
  expect((METHOD_TABLE['skills.list'] as { query: unknown }).query).toBe(listSkillsQuerySchema);
});

test('HTTP search query: coercion matches canonical, and q-max / limit-positive survive', () => {
  const q = daemonHttpContract.sessions.search.query;
  if (!q) throw new Error('expected a query schema');
  // string query-string input on HTTP parses to the same shape as typed JSON on RPC
  expect(q.parse({ q: 'hi', limit: '20' })).toEqual(searchSessionsRequestSchema.parse({ q: 'hi', limit: 20 }));
  // the regression this whole change fixes: HTTP must enforce the same length cap as RPC
  const huge = 'x'.repeat(SEARCH_QUERY_MAX + 1);
  expect(q.safeParse({ q: huge }).success).toBe(false);
  expect(searchSessionsRequestSchema.safeParse({ q: huge }).success).toBe(false);
  // positive() preserved across the coercion
  expect(q.safeParse({ limit: '0' }).success).toBe(false);
  // a literal `?q=true` is a search term, not a boolean — string fields are never coerced
  expect(q.parse({ q: 'true' })).toMatchObject({ q: 'true' });
});

test('HTTP list query: coercion matches canonical typed parse', () => {
  const q = daemonHttpContract.sessions.list.query;
  if (!q) throw new Error('expected a query schema');
  expect(q.parse({ archived: 'true', limit: '10', offset: '0' })).toEqual(
    listSessionsQuerySchema.parse({ archived: true, limit: 10, offset: 0 })
  );
  expect(q.safeParse({ archived: 'notabool' }).success).toBe(false);
});

test('HTTP messages query: boolean coercion matches canonical parse', () => {
  const q = daemonHttpContract.sessions.messages.query;
  if (!q) throw new Error('expected a query schema');
  expect(q.parse({ includeInactive: 'true', includeAncestors: 'false', limit: '5' })).toEqual(
    listMessagesQuerySchema.parse({ includeInactive: 'true', includeAncestors: 'false', limit: 5 })
  );
  expect(q.safeParse({ includeInactive: 'notabool' }).success).toBe(false);
});

test('HTTP skills query: scope matches canonical typed parse', () => {
  const q = daemonHttpContract.skills.list.query;
  if (!q) throw new Error('expected a query schema');
  expect(q.parse({ scope: 'global,atom-pack' })).toEqual(listSkillsQuerySchema.parse({ scope: 'global,atom-pack' }));
  expect(q.parse({ scope: ['global', 'atom-pack'] })).toEqual(
    listSkillsQuerySchema.parse({ scope: 'global,atom-pack' })
  );
  expect(q.parse({})).toEqual(listSkillsQuerySchema.parse({}));
  expect(q.safeParse({ scope: 'workspace' }).success).toBe(false);
  expect(q.safeParse({ scope: 'global,workspace' }).success).toBe(false);
});
