import type { Event } from '@monad/protocol';

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PolicyEngine } from '@/agent/approvals/engine.ts';
import { ApprovalStore } from '@/agent/approvals/store.ts';
import { OversightService } from '@/services/oversight.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const d = mkdtempSync(join(tmpdir(), 'apro-'));
  dirs.push(d);
  const store = await ApprovalStore.load(join(d, 'approvals.json'));
  const engine = new PolicyEngine(store, () => []);
  const events: Event[] = [];
  const oversight = new OversightService({
    publish: (e) => events.push(e),
    engine,
    originOf: () => 'agt_1',
    timeoutMs: 1000
  });
  return { oversight, events, store };
}

const req = (tool: string, key?: string) => ({ tool, sessionId: 'ses_T', highRisk: true, input: {}, key });
const requested = (e: Event[]) => e.filter((x) => x.type === 'tool.approval_requested');

test('allow-global: after approving once, the same (tool,key) is not prompted again', async () => {
  const { oversight, events } = await setup();
  const p1 = oversight.gate(req('shell_exec', 'git'));
  const id = requested(events)[0]?.payload.requestId as string;
  await oversight.respond(id, true, undefined, 'global');
  expect(await p1).toEqual({ allow: true });

  // Second call resolves immediately with no new approval request.
  const before = requested(events).length;
  expect(await oversight.gate(req('shell_exec', 'git'))).toEqual({ allow: true });
  expect(requested(events).length).toBe(before);
});

test('deny-global: a remembered deny refuses without prompting', async () => {
  const { oversight, events } = await setup();
  const p1 = oversight.gate(req('process_start'));
  const id = requested(events)[0]?.payload.requestId as string;
  await oversight.respond(id, false, 'never', 'global');
  await p1;

  const before = requested(events).length;
  expect(await oversight.gate(req('process_start'))).toMatchObject({ allow: false });
  expect(requested(events).length).toBe(before);
});

test('session allow is cleared by cancelSession (re-prompts afterwards)', async () => {
  const { oversight, events } = await setup();
  const p1 = oversight.gate(req('shell_exec', 'ls'));
  const id = requested(events)[0]?.payload.requestId as string;
  await oversight.respond(id, true, undefined, 'session');
  await p1;

  // Same session: no prompt.
  expect(await oversight.gate(req('shell_exec', 'ls'))).toEqual({ allow: true });

  oversight.cancelSession('ses_T' as never, 'done');
  // After clearing the session, a fresh call prompts again (parks pending).
  const before = requested(events).length;
  oversight.gate(req('shell_exec', 'ls'));
  expect(requested(events).length).toBe(before + 1);
  oversight.cancelSession('ses_T' as never, 'cleanup');
});

test('host escape allow downgrades to session scope (never persisted)', async () => {
  const { oversight, events, store } = await setup();
  const p1 = oversight.gate(req('code_execute', 'target:host'));
  const id = requested(events)[0]?.payload.requestId as string;
  await oversight.respond(id, true, undefined, 'global'); // requests global, must downgrade
  expect(await p1).toEqual({ allow: true });

  // Nothing persisted to disk.
  expect(store.all()).toEqual([]);
  // But within the session it is remembered (no re-prompt).
  const before = requested(events).length;
  expect(await oversight.gate(req('code_execute', 'target:host'))).toEqual({ allow: true });
  expect(requested(events).length).toBe(before);
});
