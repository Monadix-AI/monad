// The inbound-approval gate: high-risk tools in a peer-delegated (openai-compat) session follow the
// configured policy (auto/local/deny); the daemon's own sessions always reach the fallback gate.

import type { ToolGate, ToolGateRequest } from '#/capabilities/tools/types.ts';
import type { Store } from '#/store/db/index.ts';

import { expect, test } from 'bun:test';

import { createInboundApprovalGate, type InboundApprovalMode } from '#/services/inbound-approval.ts';

function storeWith(client: string | undefined): Pick<Store, 'getSession'> {
  return {
    getSession: ((_id: string) =>
      client === undefined ? { origin: undefined } : { origin: { client } }) as Store['getSession']
  };
}

function req(overrides?: Partial<ToolGateRequest>): ToolGateRequest {
  return { tool: 'shell_exec', sessionId: 'ses_1', highRisk: true, input: {}, ...overrides };
}

function gateOf(mode: InboundApprovalMode, client: string | undefined, fallback: ToolGate): ToolGate {
  return createInboundApprovalGate({ store: storeWith(client), mode: () => mode, fallback });
}

const denyFallback: ToolGate = async () => ({ allow: false, reason: 'fallback hit' });

// A store that can't find the session (deleted/unknown) — must not be treated as a delegation.
function storeMissing(): Pick<Store, 'getSession'> {
  return { getSession: (() => null) as Store['getSession'] };
}

test('auto allows high-risk tools in an openai-compat session', async () => {
  const gate = gateOf('auto', 'openai-compat', denyFallback);
  expect(await gate(req())).toEqual({ allow: true });
});

test('deny rejects high-risk tools in an openai-compat session', async () => {
  const gate = gateOf('deny', 'openai-compat', denyFallback);
  const outcome = await gate(req());
  expect(outcome.allow).toBe(false);
});

test('local falls through to the fallback gate', async () => {
  let hit = false;
  const fallback: ToolGate = async () => {
    hit = true;
    return { allow: true };
  };
  const gate = gateOf('local', 'openai-compat', fallback);
  expect(await gate(req())).toEqual({ allow: true });
  expect(hit).toBe(true);
});

test('a non-high-risk call always reaches the fallback even with auto', async () => {
  let hit = false;
  const fallback: ToolGate = async () => {
    hit = true;
    return { allow: true };
  };
  const gate = gateOf('auto', 'openai-compat', fallback);
  await gate(req({ highRisk: false }));
  expect(hit).toBe(true);
});

test('a non-delegation session (different client) is unaffected by the policy', async () => {
  let hit = false;
  const fallback: ToolGate = async () => {
    hit = true;
    return { allow: false, reason: 'fallback' };
  };
  // auto would allow if it matched, but a web session must reach the real gate.
  const gate = gateOf('auto', 'web', fallback);
  const outcome = await gate(req());
  expect(hit).toBe(true);
  expect(outcome.allow).toBe(false);
});

test('a session with an origin but no client falls through to the fallback', async () => {
  let hit = false;
  const fallback: ToolGate = async () => {
    hit = true;
    return { allow: false, reason: 'fallback' };
  };
  // storeWith(undefined) returns origin:undefined → not a delegation, even under auto.
  const gate = gateOf('auto', undefined, fallback);
  await gate(req());
  expect(hit).toBe(true);
});

test('an unknown/deleted session (getSession null) reaches the fallback, not auto-allow', async () => {
  let hit = false;
  const fallback: ToolGate = async () => {
    hit = true;
    return { allow: false, reason: 'fallback' };
  };
  const gate = createInboundApprovalGate({ store: storeMissing(), mode: () => 'auto', fallback });
  const outcome = await gate(req());
  expect(hit).toBe(true);
  expect(outcome.allow).toBe(false);
});
