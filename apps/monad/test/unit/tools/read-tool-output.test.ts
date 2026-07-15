import type { ToolContext } from '#/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { createReadToolOutputTool, type RawOutputStore } from '#/capabilities/tools/registry/read-tool-output.ts';

function rawStore(entries: Record<string, string> = {}): RawOutputStore {
  const m = new Map(Object.entries(entries));
  return { get: (sessionId, toolCallId) => m.get(`${sessionId}:${toolCallId}`) ?? null };
}

const ctx = (sessionId: string): ToolContext => ({ sessionId, log: () => {} });

function tool(store: RawOutputStore) {
  const [t] = createReadToolOutputTool(store);
  return t as NonNullable<typeof t>;
}

test('reads back the full spilled output for a known handle', async () => {
  const store = rawStore({ 'ses_100000000000:call_1': 'ABCDEFGHIJ' });
  const t = tool(store);
  const result = await t.run({ id: 'call_1' }, ctx('ses_100000000000'));
  expect(result.metadata).toEqual({ found: true });
  expect(result.modelContent).toBe('ABCDEFGHIJ');
});

test('unknown handle returns found:false with an explanatory message, not an error', async () => {
  const store = rawStore();
  const t = tool(store);
  const result = await t.run({ id: 'nope' }, ctx('ses_100000000000'));
  expect(result.metadata).toEqual({ found: false });
  expect(String(result.modelContent)).toContain('No spilled output found');
});

test('offset/limit pages through the output', async () => {
  const store = rawStore({ 'ses_100000000000:call_1': '0123456789' });
  const t = tool(store);
  const result = await t.run({ id: 'call_1', offset: 3, limit: 4 }, ctx('ses_100000000000'));
  expect(result.modelContent).toBe('3456');
});

test('grep filters to matching lines only', async () => {
  const store = rawStore({ 'ses_100000000000:call_1': 'line one\nERROR: bad\nline three' });
  const t = tool(store);
  const result = await t.run({ id: 'call_1', grep: 'ERROR' }, ctx('ses_100000000000'));
  expect(result.modelContent).toBe('ERROR: bad');
});

test('grep with no matches says so rather than returning empty', async () => {
  const store = rawStore({ 'ses_100000000000:call_1': 'nothing interesting here' });
  const t = tool(store);
  const result = await t.run({ id: 'call_1', grep: 'ERROR' }, ctx('ses_100000000000'));
  expect(String(result.modelContent)).toContain('no lines contain');
});

test('a session cannot read a handle scoped to a different session', async () => {
  const store = rawStore({ 'ses_100000000000:call_1': 'secret bytes' });
  const t = tool(store);
  const result = await t.run({ id: 'call_1' }, ctx('ses_200000000000'));
  expect(result.metadata).toEqual({ found: false });
});
