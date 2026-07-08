// E2E: the tiered-scope approval allowlist over BOTH transports (TCP + Unix socket). Drives the
// real HTTP surface — POST /v1/tools/approve (with scope), GET /v1/approvals, POST
// /v1/approvals/revoke — against a real PolicyEngine + ApprovalStore (temp file), and checks the
// in-process gate decision reflects the remembered rule. Mirrors docs/runtime.md's both-transports rule.

import type { Event } from '@monad/protocol';

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HOST_CONTROL_KEY, PolicyEngine } from '#/agent/approvals/engine.ts';
import { ApprovalStore } from '#/agent/approvals/store.ts';
import { OversightService } from '#/services/oversight.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportKind } from '../helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(kind: TransportKind) {
  const dir = mkdtempSync(join(tmpdir(), 'apr-e2e-'));
  dirs.push(dir);
  const store = await ApprovalStore.load(join(dir, 'approvals.json'));
  const engine = new PolicyEngine(store, () => []);
  const events: Event[] = [];
  const oversight = new OversightService({
    publish: (e) => events.push(e),
    engine,
    originOf: () => null,
    timeoutMs: 5_000
  });
  const app = createHttpTransport(buildHandlers(mockModel(), undefined, { oversight }));
  const t = serveTransport(kind, app);
  return { t, oversight, events, store };
}

const gateReq = {
  tool: 'shell_exec',
  sessionId: 'ses_E2E',
  highRisk: true,
  input: { command: 'git status' },
  key: 'git'
};
const requested = (e: Event[]) => e.filter((x) => x.type === 'tool.approval_requested');
const json = (m: string, b: unknown) => ({
  method: m,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(b)
});

for (const kind of TRANSPORTS) {
  describe(`approvals over ${kind}`, () => {
    test('approve(global) persists → no re-prompt; GET lists it; revoke restores prompting', async () => {
      const { t, oversight, events, store } = await setup(kind);
      try {
        // 1. A gate parks a pending approval; approve it with scope:'global' over the transport.
        const p1 = oversight.gate(gateReq);
        const requestId = requested(events)[0]?.payload.requestId as string;
        const approveRes = await t.fetch(
          '/v1/tools/approve',
          json('POST', { requestId, allow: true, scope: 'global' })
        );
        expect(approveRes.status).toBe(200);
        expect(await p1).toEqual({ allow: true });

        // 2. The same (tool,key) now resolves immediately — no new approval request emitted.
        const before = requested(events).length;
        expect(await oversight.gate(gateReq)).toEqual({ allow: true });
        expect(requested(events).length).toBe(before);

        // 3. GET /v1/approvals lists the remembered rule.
        const listRes = await t.fetch('/v1/approvals');
        expect(listRes.status).toBe(200);
        const { rules } = (await listRes.json()) as {
          rules: { id: string; tool: string; key?: string; scope: string }[];
        };
        const rule = rules.find((r) => r.tool === 'shell_exec' && r.key === 'git');
        expect(rule).toMatchObject({ scope: 'global' });
        expect(store.all()).toHaveLength(1);

        // 4. Revoke over the transport → the gate prompts again (parks a fresh pending).
        const revokeRes = await t.fetch('/v1/approvals/revoke', json('POST', { id: rule?.id }));
        expect(revokeRes.status).toBe(200);
        expect(((await revokeRes.json()) as { ok: boolean }).ok).toBe(true);

        const afterRevoke = requested(events).length;
        oversight.gate(gateReq); // parks (ask) — must emit a new request
        expect(requested(events).length).toBe(afterRevoke + 1);
      } finally {
        await t.stop();
      }
    });

    test('clear removes all remembered rules', async () => {
      const { t, oversight, events } = await setup(kind);
      try {
        const p1 = oversight.gate(gateReq);
        const requestId = requested(events)[0]?.payload.requestId as string;
        await t.fetch('/v1/tools/approve', json('POST', { requestId, allow: true, scope: 'global' }));
        await p1;

        const clearRes = await t.fetch('/v1/approvals/clear', json('POST', {}));
        expect(clearRes.status).toBe(200);
        const list = (await (await t.fetch('/v1/approvals')).json()) as { rules: unknown[] };
        expect(list.rules).toHaveLength(0);
      } finally {
        await t.stop();
      }
    });

    test('host-control: a session grant covers the whole desktop-control class (one approval, no re-prompt)', async () => {
      const { t, oversight, events } = await setup(kind);
      const click = {
        tool: 'computer__click_screen',
        sessionId: 'ses_HC',
        highRisk: true,
        input: {},
        key: HOST_CONTROL_KEY
      };
      const type = {
        tool: 'computer__type_text',
        sessionId: 'ses_HC',
        highRisk: true,
        input: {},
        key: HOST_CONTROL_KEY
      };
      try {
        // Grant "control this computer for this session" over the transport.
        const p1 = oversight.gate(click);
        const requestId = requested(events)[0]?.payload.requestId as string;
        const res = await t.fetch('/v1/tools/approve', json('POST', { requestId, allow: true, scope: 'session' }));
        expect(res.status).toBe(200);
        expect(await p1).toEqual({ allow: true });

        // A DIFFERENT mutating desktop tool in the same session resolves immediately — class grant.
        const before = requested(events).length;
        expect(await oversight.gate(type)).toEqual({ allow: true });
        expect(requested(events).length).toBe(before);
      } finally {
        await t.stop();
      }
    });
  });
}
