import type { ApprovalRule } from '@monad/protocol';

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildOperatorRules,
  decideFromRules,
  HOST_CONTROL_KEY,
  HostEscapePersistError,
  isHostEscape,
  PolicyEngine,
  parseOperatorEntry,
  ruleMatches
} from '#/agent/approvals/engine.ts';
import { ApprovalStore } from '#/agent/approvals/store.ts';

const dirs: string[] = [];
function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'apr-'));
  dirs.push(d);
  return join(d, 'approvals.json');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rule(p: Partial<ApprovalRule>): ApprovalRule {
  return {
    id: p.id ?? 'r1',
    tool: p.tool ?? 'shell_exec',
    key: p.key,
    decision: p.decision ?? 'allow',
    scope: p.scope ?? 'global',
    agentId: p.agentId,
    sessionId: p.sessionId,
    createdAt: '2026-01-01T00:00:00.000Z',
    source: p.source ?? 'runtime'
  };
}

test('ruleMatches: whole-tool rule matches any key; keyed rule needs exact key', () => {
  expect(ruleMatches(rule({ tool: 'shell_exec' }), { tool: 'shell_exec', key: 'git' })).toBe(true);
  expect(ruleMatches(rule({ tool: 'shell_exec', key: 'git' }), { tool: 'shell_exec', key: 'git' })).toBe(true);
  expect(ruleMatches(rule({ tool: 'shell_exec', key: 'git' }), { tool: 'shell_exec', key: 'rm' })).toBe(false);
  expect(ruleMatches(rule({ tool: 'shell_exec' }), { tool: 'code_execute' })).toBe(false);
});

test('decideFromRules: deny wins over allow regardless of order', () => {
  const rules = [rule({ id: 'a', decision: 'allow' }), rule({ id: 'd', decision: 'deny' })];
  expect(decideFromRules({ tool: 'shell_exec' }, rules)).toBe('deny');
});

test('decideFromRules: allow when only allow matches; ask when nothing matches', () => {
  expect(decideFromRules({ tool: 'shell_exec' }, [rule({ decision: 'allow' })])).toBe('allow');
  expect(decideFromRules({ tool: 'shell_exec' }, [rule({ tool: 'other' })])).toBe('ask');
});

test('parseOperatorEntry: splits on the first colon so multi-colon keys survive', () => {
  expect(parseOperatorEntry('shell_exec')).toEqual({ tool: 'shell_exec' });
  expect(parseOperatorEntry('shell_exec:git')).toEqual({ tool: 'shell_exec', key: 'git' });
  expect(parseOperatorEntry('code_execute:target:host')).toEqual({ tool: 'code_execute', key: 'target:host' });
});

test('buildOperatorRules: deny + allow become rules, ask is ignored', () => {
  const rules = buildOperatorRules({ deny: ['code_execute:target:host'], allow: ['shell_exec:git'] });
  expect(rules).toHaveLength(2);
  expect(rules.every((r) => r.source === 'operator')).toBe(true);
  expect(rules.find((r) => r.decision === 'deny')).toMatchObject({ tool: 'code_execute', key: 'target:host' });
});

test('operator deny cannot be overridden by a runtime global allow', async () => {
  const store = await ApprovalStore.load(tmpFile());
  const operator = buildOperatorRules({ deny: ['shell_exec'], allow: [] });
  const engine = new PolicyEngine(store, () => operator);
  await engine.record({
    tool: 'shell_exec',
    decision: 'allow',
    scope: 'global',
    sessionId: 'ses_X00000000000',
    agentId: null
  });
  expect(engine.decide({ tool: 'shell_exec', sessionId: 'ses_X00000000000', agentId: null })).toBe('deny');
});

test('scopes aggregate: agent rule applies only to its agent; session rule only to its session', async () => {
  const store = await ApprovalStore.load(tmpFile());
  const engine = new PolicyEngine(store, () => []);
  await engine.record({
    tool: 'shell_exec',
    decision: 'allow',
    scope: 'agent',
    sessionId: 's',
    agentId: 'agt_100000000000'
  });
  await engine.record({
    tool: 'process_start',
    decision: 'allow',
    scope: 'session',
    sessionId: 'ses_A00000000000',
    agentId: null
  });

  expect(engine.decide({ tool: 'shell_exec', sessionId: 's', agentId: 'agt_100000000000' })).toBe('allow');
  expect(engine.decide({ tool: 'shell_exec', sessionId: 's', agentId: 'agt_200000000000' })).toBe('ask');
  expect(engine.decide({ tool: 'process_start', sessionId: 'ses_A00000000000', agentId: null })).toBe('allow');
  expect(engine.decide({ tool: 'process_start', sessionId: 'ses_B00000000000', agentId: null })).toBe('ask');
});

test('host escape: persistent allow is refused, session allow is fine, deny may persist', async () => {
  const store = await ApprovalStore.load(tmpFile());
  const engine = new PolicyEngine(store, () => []);
  const host = {
    tool: 'code_execute',
    key: 'target:host',
    sessionId: 'ses_X00000000000',
    agentId: 'agt_100000000000' as string | null
  };

  await expect(engine.record({ ...host, decision: 'allow', scope: 'global' })).rejects.toBeInstanceOf(
    HostEscapePersistError
  );
  await expect(engine.record({ ...host, decision: 'allow', scope: 'agent' })).rejects.toBeInstanceOf(
    HostEscapePersistError
  );
  await engine.record({ ...host, decision: 'allow', scope: 'session' }); // ok
  await engine.record({ ...host, decision: 'deny', scope: 'global' }); // deny may persist
  expect(
    engine.decide({
      tool: 'code_execute',
      key: 'target:host',
      sessionId: 'ses_X00000000000',
      agentId: 'agt_100000000000'
    })
  ).toBe('deny');
});

test('isHostEscape: host-control key (computer-use) and code_execute target:host both escape', () => {
  expect(isHostEscape('computer__click_screen', HOST_CONTROL_KEY)).toBe(true);
  expect(isHostEscape('code_execute', 'target:host')).toBe(true);
  expect(isHostEscape('code_execute', 'target:sandbox')).toBe(false);
  expect(isHostEscape('computer__take_screenshot', undefined)).toBe(false); // read-only, no key
});

test('host-control is a CLASS grant: one rule covers every mutating tool by key alone', () => {
  // A session allow recorded for one mutating tool must cover differently-named mutating tools,
  // because "control this computer for this session" should not re-prompt per action.
  const grant = rule({ key: HOST_CONTROL_KEY, decision: 'allow', tool: 'computer__click_screen' });
  expect(ruleMatches(grant, { tool: 'computer__type_text', key: HOST_CONTROL_KEY })).toBe(true);
  expect(ruleMatches(grant, { tool: 'computer__scroll', key: HOST_CONTROL_KEY })).toBe(true);
  // But it must NOT leak to non-host-control requests of the same tool name.
  expect(ruleMatches(grant, { tool: 'computer__click_screen' })).toBe(false);
});

test('host-control: session allow grants the whole class; global/agent allow is refused', async () => {
  const store = await ApprovalStore.load(tmpFile());
  const engine = new PolicyEngine(store, () => []);
  const click = { tool: 'computer__click_screen', key: HOST_CONTROL_KEY, sessionId: 'ses_A00000000000', agentId: null };

  await expect(engine.record({ ...click, decision: 'allow', scope: 'global' })).rejects.toBeInstanceOf(
    HostEscapePersistError
  );
  await engine.record({ ...click, decision: 'allow', scope: 'session' }); // ok — session grant

  // The session grant covers a DIFFERENT mutating tool (class grant), but not other sessions.
  expect(
    engine.decide({ tool: 'computer__type_text', key: HOST_CONTROL_KEY, sessionId: 'ses_A00000000000', agentId: null })
  ).toBe('allow');
  expect(
    engine.decide({ tool: 'computer__type_text', key: HOST_CONTROL_KEY, sessionId: 'ses_B00000000000', agentId: null })
  ).toBe('ask');
});

test('host-control: an operator deny kills the whole desktop-control class', () => {
  const deny = rule({ key: HOST_CONTROL_KEY, decision: 'deny', tool: 'computer__click_screen', source: 'operator' });
  const allow = rule({ key: HOST_CONTROL_KEY, decision: 'allow', tool: 'computer__type_text', scope: 'session' });
  expect(decideFromRules({ tool: 'computer__scroll', key: HOST_CONTROL_KEY }, [allow, deny])).toBe('deny');
});

test('clearSession drops only that session; revoke removes a single rule', async () => {
  const store = await ApprovalStore.load(tmpFile());
  const engine = new PolicyEngine(store, () => []);
  const g = await engine.record({
    tool: 'shell_exec',
    decision: 'allow',
    scope: 'global',
    sessionId: 's',
    agentId: null
  });
  await engine.record({
    tool: 'process_start',
    decision: 'allow',
    scope: 'session',
    sessionId: 'ses_A00000000000',
    agentId: null
  });

  engine.clearSession('ses_A00000000000');
  expect(engine.decide({ tool: 'process_start', sessionId: 'ses_A00000000000', agentId: null })).toBe('ask');
  expect(engine.decide({ tool: 'shell_exec', sessionId: 's', agentId: null })).toBe('allow');

  expect(await engine.revoke(g.id)).toBe(true);
  expect(engine.decide({ tool: 'shell_exec', sessionId: 's', agentId: null })).toBe('ask');
});
