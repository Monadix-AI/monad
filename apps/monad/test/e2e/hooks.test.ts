// e2e: lifecycle command hooks drive a real turn through the daemon's full HTTP surface over BOTH
// transports (TCP + unix socket). Proves the config → HookRunner → agent loop → event-stream wiring
// end to end, not just the unit-level fakes. Uses shell command hooks (the user-facing path), so
// Bun.spawn round-trips through the real daemon.

import type { HookConfig } from '#/hooks/runner.ts';

import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { createLogger } from '@monad/logger';
import { parseEventPayload } from '@monad/protocol';

import { createHookRunner } from '#/hooks/runner.ts';
import { MOCK_REPLY } from '#/infra/mock-model.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, stubModelDeps, TRANSPORTS } from '../helpers.ts';

const log = createLogger('e2e-hooks');

function appWithHooks(config: HookConfig) {
  const hooks = createHookRunner({ config, atomHooks: new Map(), cwd: tmpdir(), log });
  return createHttpTransport(buildHandlers(mockModel(), stubModelDeps(), { hooks, hookCwd: tmpdir() }));
}

/** Create a session, send one message, and return the turn's completed assistant text. */
async function runTurn(tr: ReturnType<typeof serveTransport>, text: string): Promise<string | undefined> {
  const created = (await (
    await tr.fetch('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'e2e-hooks' })
    })
  ).json()) as { sessionId: string };
  const sid = created.sessionId;
  await tr.fetch(`/v1/sessions/${sid}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text })
  });
  const events = await tr.sse(`/v1/sessions/${sid}/events`, {
    until: (e) => e.type === 'session.message.completed',
    timeoutMs: 4000
  });
  const completed = events.find((e) => e.type === 'session.message.completed');
  return completed ? parseEventPayload('session.message.completed', completed.payload).message.text : undefined;
}

for (const kind of TRANSPORTS) {
  test(`[${kind}] BeforeTurn command hook (exit 2) aborts the turn with its reason`, async () => {
    const tr = serveTransport(
      kind,
      appWithHooks({ BeforeTurn: [{ hooks: [{ command: 'echo "blocked by e2e policy" >&2; exit 2' }] }] })
    );
    try {
      expect(await runTurn(tr, 'do something risky')).toBe('blocked by e2e policy');
    } finally {
      await tr.stop();
    }
  });

  test(`[${kind}] Stop command hook rewrites the final answer`, async () => {
    const tr = serveTransport(
      kind,
      appWithHooks({ AfterTurn: [{ hooks: [{ command: `echo '{"mutatedText":"REWRITTEN"}'` }] }] })
    );
    try {
      expect(await runTurn(tr, 'hi')).toBe('REWRITTEN');
    } finally {
      await tr.stop();
    }
  });

  test(`[${kind}] AfterModel command hook rewrites the model response`, async () => {
    const tr = serveTransport(
      kind,
      appWithHooks({ AfterModel: [{ hooks: [{ command: `echo '{"mutatedText":"FROM_AFTERMODEL"}'` }] }] })
    );
    try {
      expect(await runTurn(tr, 'hi')).toBe('FROM_AFTERMODEL');
    } finally {
      await tr.stop();
    }
  });

  test(`[${kind}] no hooks configured → normal reply (control)`, async () => {
    const tr = serveTransport(kind, appWithHooks({}));
    try {
      expect(await runTurn(tr, 'hi')).toBe(MOCK_REPLY);
    } finally {
      await tr.stop();
    }
  });
}
