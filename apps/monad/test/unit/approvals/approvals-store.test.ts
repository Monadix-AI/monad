import type { ApprovalRule } from '@monad/protocol';

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApprovalStore } from '#/agent/approvals/store.ts';

const dirs: string[] = [];
function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'aprs-'));
  dirs.push(d);
  return join(d, 'approvals.json');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rule(id: string, p: Partial<ApprovalRule> = {}): ApprovalRule {
  return {
    id,
    tool: p.tool ?? 'shell_exec',
    key: p.key,
    decision: p.decision ?? 'allow',
    scope: p.scope ?? 'global',
    agentId: p.agentId,
    sessionId: p.sessionId,
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'runtime'
  };
}

test('persists global + agent rules across a reload', async () => {
  const file = tmpFile();
  const store = await ApprovalStore.load(file);
  await store.add(rule('g1', { scope: 'global' }));
  await store.add(rule('a1', { scope: 'agent', agentId: 'agt_100000000000' }));

  const reloaded = await ApprovalStore.load(file);
  expect(reloaded.global().map((r) => r.id)).toEqual(['g1']);
  expect(reloaded.forAgent('agt_100000000000').map((r) => r.id)).toEqual(['a1']);
  expect(reloaded.all()).toHaveLength(2);
});

test('a corrupt file loads as empty (fail-closed)', async () => {
  const file = tmpFile();
  await Bun.write(file, '{ this is not valid json');
  const store = await ApprovalStore.load(file);
  expect(store.all()).toEqual([]);
});

test('a schema-mismatched file loads as empty (fail-closed)', async () => {
  const file = tmpFile();
  await Bun.write(file, JSON.stringify({ version: 99, global: 'nope' }));
  const store = await ApprovalStore.load(file);
  expect(store.all()).toEqual([]);
});

test('remove deletes by id and prunes empty agent buckets', async () => {
  const file = tmpFile();
  const store = await ApprovalStore.load(file);
  await store.add(rule('a1', { scope: 'agent', agentId: 'agt_1' }));
  expect(await store.remove('a1')).toBe(true);
  expect(await store.remove('a1')).toBe(false);
  const reloaded = await ApprovalStore.load(file);
  expect(reloaded.forAgent('agt_1')).toEqual([]);
});

test('clear filters by scope/agent', async () => {
  const file = tmpFile();
  const store = await ApprovalStore.load(file);
  await store.add(rule('g1', { scope: 'global' }));
  await store.add(rule('a1', { scope: 'agent', agentId: 'agt_100000000000' }));
  await store.add(rule('a2', { scope: 'agent', agentId: 'agt_200000000000' }));

  expect(await store.clear({ scope: 'agent', agentId: 'agt_100000000000' })).toBe(1);
  expect(store.forAgent('agt_200000000000')).toHaveLength(1);
  expect(store.global()).toHaveLength(1);

  expect(await store.clear()).toBe(2);
});
