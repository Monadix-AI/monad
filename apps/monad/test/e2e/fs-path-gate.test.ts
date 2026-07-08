// E2E: path_access gate — the out-of-sandbox path escalation flow over both transports.
// Drives the real HTTP surface (POST /v1/tools/approve, GET /v1/approvals, POST
// /v1/approvals/revoke) against a real PolicyEngine + ApprovalStore, verifying that path
// escalation behaves identically to the general approval flow but with scope:'agent' (not
// 'global') for the "Always" choice. Mirrors docs/runtime.md's both-transports rule.

import type { Event } from '@monad/protocol';

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PolicyEngine } from '@/agent/approvals/engine.ts';
import { ApprovalStore } from '@/agent/approvals/store.ts';
import { OversightService } from '@/services/oversight.ts';
import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportKind } from '../helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(kind: TransportKind) {
  const dir = mkdtempSync(join(tmpdir(), 'fs-gate-e2e-'));
  dirs.push(dir);
  const store = await ApprovalStore.load(join(dir, 'approvals.json'));
  const engine = new PolicyEngine(store, () => []);
  const events: Event[] = [];
  const oversight = new OversightService({
    publish: (e) => events.push(e),
    engine,
    originOf: (sid) => (sid === SESSION_ID ? AGENT_ID : null),
    timeoutMs: 5_000
  });
  const app = createHttpTransport(buildHandlers(mockModel(), undefined, { oversight }));
  const t = serveTransport(kind, app);
  return { t, oversight, events, store };
}

const DESKTOP = '/tmp/monad-e2e-desktop';
const SESSION_ID = 'ses_FSG';
const AGENT_ID = 'agent_FSG_test';
const pathGateReq = {
  tool: 'path_access',
  sessionId: SESSION_ID,
  highRisk: false,
  input: {
    path: `${DESKTOP}/report.txt`,
    dir: DESKTOP,
    operation: 'write',
    defaultScope: 'session',
    rememberScopes: ['once', 'session', 'agent', 'global']
  },
  key: `write:${DESKTOP}`
};

const requested = (e: Event[]) => e.filter((x) => x.type === 'tool.approval_requested');
const json = (m: string, b: unknown) => ({
  method: m,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(b)
});

for (const kind of TRANSPORTS) {
  describe(`path_access gate over ${kind}`, () => {
    test('scope:agent persists → no re-prompt; GET lists rule with directory key; revoke restores prompting', async () => {
      const { t, oversight, events, store } = await setup(kind);
      try {
        // 1. Gate parks a pending request; approve with scope:'agent' (the "Always" UI choice).
        const p1 = oversight.gate(pathGateReq);
        const requestId = requested(events)[0]?.payload.requestId as string;
        const approveRes = await t.fetch('/v1/tools/approve', json('POST', { requestId, allow: true, scope: 'agent' }));
        expect(approveRes.status).toBe(200);
        expect(await p1).toEqual({ allow: true });

        // 2. Same (tool, key) resolves immediately — no new approval event emitted.
        const before = requested(events).length;
        expect(await oversight.gate(pathGateReq)).toEqual({ allow: true });
        expect(requested(events).length).toBe(before);

        // 3. GET /v1/approvals lists the rule with tool:'path_access' and the operation-scoped key.
        const listRes = await t.fetch('/v1/approvals');
        expect(listRes.status).toBe(200);
        const { rules } = (await listRes.json()) as {
          rules: { id: string; tool: string; key?: string; scope: string }[];
        };
        const rule = rules.find((r) => r.tool === 'path_access' && r.key === `write:${DESKTOP}`);
        expect(rule).toMatchObject({ scope: 'agent', agentId: AGENT_ID });
        expect(store.all()).toHaveLength(1);

        // 4. Revoke over the transport → the gate prompts again.
        const revokeRes = await t.fetch('/v1/approvals/revoke', json('POST', { id: rule?.id }));
        expect(revokeRes.status).toBe(200);
        expect(((await revokeRes.json()) as { ok: boolean }).ok).toBe(true);

        const afterRevoke = requested(events).length;
        oversight.gate(pathGateReq); // parks — must emit a new request
        expect(requested(events).length).toBe(afterRevoke + 1);
      } finally {
        await t.stop();
      }
    });

    test('scope:once resolves the pending gate but stores no rule', async () => {
      const { t, oversight, events, store } = await setup(kind);
      try {
        const p1 = oversight.gate(pathGateReq);
        const requestId = requested(events)[0]?.payload.requestId as string;
        await t.fetch('/v1/tools/approve', json('POST', { requestId, allow: true, scope: 'once' }));
        expect(await p1).toEqual({ allow: true });

        // No rule persisted — the next request parks again.
        expect(store.all()).toHaveLength(0);
        const afterOnce = requested(events).length;
        oversight.gate(pathGateReq);
        expect(requested(events).length).toBe(afterOnce + 1);
      } finally {
        await t.stop();
      }
    });

    test('deny resolves with allow:false and stores no rule', async () => {
      const { t, oversight, events, store } = await setup(kind);
      try {
        const p1 = oversight.gate(pathGateReq);
        const requestId = requested(events)[0]?.payload.requestId as string;
        await t.fetch('/v1/tools/approve', json('POST', { requestId, allow: false, scope: 'once' }));
        expect(await p1).toMatchObject({ allow: false });
        expect(store.all()).toHaveLength(0);
      } finally {
        await t.stop();
      }
    });
  });
}
