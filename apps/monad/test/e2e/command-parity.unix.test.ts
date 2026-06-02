// e2e: a slash command must behave IDENTICALLY over every transport the daemon serves (docs/runtime.md).
// We mount the same handlers over TCP loopback AND a Unix socket, run the same commands through the
// blocking message endpoint (which returns the directive reply), and assert the replies match.

import { afterEach, expect, test } from 'bun:test';

import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

const handles: TransportHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()));
});

/** Create a session and run one slash command through the blocking endpoint; return the directive text. */
async function runCommand(t: TransportHandle, text: string): Promise<string> {
  const created = await t.fetch('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'parity' })
  });
  const { sessionId } = (await created.json()) as { sessionId: string };
  const res = await t.fetch(`/v1/sessions/${sessionId}/messages/block`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text })
  });
  const body = (await res.json()) as { message: { text: string; type?: string } };
  return body.message.text;
}

test('slash commands produce identical directive replies over TCP and the unix socket', async () => {
  // One handler set, two transports — exactly how main.ts serves the daemon.
  const handlers = buildHandlers(mockModel());
  const byKind: Record<string, TransportHandle> = {};
  for (const kind of TRANSPORTS) {
    const h = serveTransport(kind, createHttpTransport(handlers));
    handles.push(h);
    byKind[kind] = h;
  }

  // Deterministic commands only: /sessions enumerates the shared store, which legitimately holds
  // one more session by the time the second transport runs (each runCommand creates one) — that's
  // store state, not a transport difference.
  for (const cmd of ['/help', '/reset']) {
    const tcp = await runCommand(byKind.tcp as TransportHandle, cmd);
    const unix = await runCommand(byKind.unix as TransportHandle, cmd);
    expect(tcp.length).toBeGreaterThan(0);
    expect(unix).toBe(tcp); // same command → same directive reply on either transport
  }
});

test('the block endpoint tags a command reply as a directive (no model turn)', async () => {
  const handlers = buildHandlers(mockModel());
  const t = serveTransport('tcp', createHttpTransport(handlers));
  handles.push(t);

  const created = await t.fetch('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'directive' })
  });
  const { sessionId } = (await created.json()) as { sessionId: string };
  const res = await t.fetch(`/v1/sessions/${sessionId}/messages/block`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '/help' })
  });
  const body = (await res.json()) as { message: { text: string; type?: string } };
  expect(body.message.type).toBe('directive');
  expect(body.message.text).toContain('/reset');
});
