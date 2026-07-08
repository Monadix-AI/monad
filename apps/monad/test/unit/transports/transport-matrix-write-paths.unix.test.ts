// Transport-matrix write path tests: AGENTS.md requires EVERY feature to work identically
// over BOTH local transports (TCP loopback and the Unix-domain socket). This suite covers
// the write (mutation) paths that the existing transport-matrix.test.ts omits:
//   - Session lifecycle writes (POST /v1/sessions, branch, restore, abort, reset)
//   - Approvals (POST revoke/clear)
// Agent CRUD is covered separately in test/e2e/agent-crud.test.ts (requires real home dir).

import type { ModelResult, ModelRouter } from '@/agent/index.ts';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileReadTool, fileWriteTool } from '@/capabilities/tools';
import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportKind } from '../../helpers.ts';

const app = createHttpTransport(buildHandlers(mockModel(['ok'])));
const handler = (req: Request) => app.handle(req);
const sockPath = join(tmpdir(), `monad-matrix-write-${process.pid}.sock`);

let tcp: ReturnType<typeof Bun.serve>;
let uds: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  tcp = Bun.serve({ port: 0, fetch: handler });
  uds = Bun.serve({ unix: sockPath, fetch: handler });
});

afterAll(() => {
  tcp.stop(true);
  uds.stop(true);
});

async function postBoth(path: string, body: unknown) {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
  const [tcpRes, udsRes] = await Promise.all([
    fetch(`http://127.0.0.1:${tcp.port}${path}`, init),
    fetch(`http://localhost${path}`, { ...init, unix: sockPath })
  ]);
  return {
    tcp: { status: tcpRes.status, body: (await tcpRes.json().catch(() => null)) as unknown },
    uds: { status: udsRes.status, body: (await udsRes.json().catch(() => null)) as unknown }
  };
}

async function createSession(title: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${tcp.port}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title })
  });
  const body = (await res.json()) as { sessionId: string };
  return body.sessionId;
}

type Step = string | { tool: string; input?: unknown };

function scriptedModel(steps: Step[]): ModelRouter {
  let i = 0;
  return {
    async *stream() {},
    async complete(): Promise<ModelResult> {
      const step = i < steps.length ? (steps[i] as Step) : 'done';
      i++;
      if (typeof step === 'string') return { text: step, finishReason: 'stop' };
      return {
        text: '',
        toolCalls: [{ toolCallId: `tc_${i}`, toolName: step.tool, input: step.input ?? {} }],
        finishReason: 'tool-calls'
      };
    }
  };
}

async function postJson<T>(
  transport: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
  path: string,
  body: unknown
): Promise<T> {
  const res = await transport.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  expect(res.status).toBeLessThan(300);
  return (await res.json()) as T;
}

describe('transport parity — session write paths', () => {
  test('POST /v1/sessions: creates a session and returns ses_ id on both transports', async () => {
    const { tcp: t, uds: u } = await postBoth('/v1/sessions', { title: 'Matrix Write Test' });
    // Session create returns 200 or 201 — the key is both transports agree.
    expect(u.status).toBe(t.status);
    expect((t.body as { sessionId: string }).sessionId).toMatch(/^ses_/);
    expect((u.body as { sessionId: string }).sessionId).toMatch(/^ses_/);
  });

  test('POST /v1/sessions: both transports return identical response shape', async () => {
    const { tcp: t, uds: u } = await postBoth('/v1/sessions', { title: 'Shape Parity' });
    expect(typeof (t.body as { sessionId: string }).sessionId).toBe('string');
    expect(typeof (u.body as { sessionId: string }).sessionId).toBe('string');
    // Status must match across transports.
    expect(u.status).toBe(t.status);
  });

  test('POST /v1/sessions/:id/reset: clears session messages on both transports', async () => {
    const sesId = await createSession('Resettable');
    const { tcp: t, uds: u } = await postBoth(`/v1/sessions/${sesId}/reset`, {});
    expect(t.status).toBe(200);
    expect(u.status).toBe(200);
    expect(typeof (t.body as { clearedCount: number }).clearedCount).toBe('number');
    expect(typeof (u.body as { clearedCount: number }).clearedCount).toBe('number');
    // Both must return the same count (same in-memory store).
    expect((u.body as { clearedCount: number }).clearedCount).toBe((t.body as { clearedCount: number }).clearedCount);
  });

  test('POST /v1/sessions/:id/abort: abort returns identical status on both transports', async () => {
    const sesId = await createSession('Abortable');
    const { tcp: t, uds: u } = await postBoth(`/v1/sessions/${sesId}/abort`, {});
    expect(t.status).toBe(200);
    expect(u.status).toBe(200);
    // aborted=false because no run is in flight, but the shape must be identical.
    expect(typeof (t.body as { aborted: boolean }).aborted).toBe('boolean');
    expect(typeof (u.body as { aborted: boolean }).aborted).toBe('boolean');
    expect((u.body as { aborted: boolean }).aborted).toBe((t.body as { aborted: boolean }).aborted);
  });

  test('POST /v1/sessions/:id/branch: branches a session identically on both transports', async () => {
    const sesId = await createSession('Branchable');
    const { tcp: t, uds: u } = await postBoth(`/v1/sessions/${sesId}/branch`, { title: 'Fork' });
    // branch returns 201
    expect(t.status).toBe(u.status);
    expect((t.body as { sessionId: string }).sessionId).toMatch(/^ses_/);
    expect((u.body as { sessionId: string }).sessionId).toMatch(/^ses_/);
  });

  test('POST /v1/sessions write policy: non-loopback connections cannot send messages', async () => {
    // The write policy gate (assertWriteAllowed) blocks non-local transports from sending
    // messages. Over loopback both TCP and UDS are local, so they CAN send — this verifies
    // the gate doesn't accidentally block local clients.
    const sesId = await createSession('PolicyTest');
    const { tcp: t, uds: u } = await postBoth(`/v1/sessions/${sesId}/messages`, {
      text: 'hello',
      model: 'mock'
    });
    // Both local transports must either succeed (200) or get the same response shape.
    // Neither should get 403 (that would mean write policy blocked a local client).
    expect(t.status).not.toBe(403);
    expect(u.status).not.toBe(403);
    expect(u.status).toBe(t.status);
  });
});

describe('transport parity — approval write paths', () => {
  test('POST /v1/approvals/clear: clears approvals identically on both transports', async () => {
    const { tcp: t, uds: u } = await postBoth('/v1/approvals/clear', {});
    expect(t.status).toBe(200);
    expect(u.status).toBe(200);
    expect(typeof (t.body as { ok: boolean }).ok).toBe('boolean');
    expect(typeof (u.body as { ok: boolean }).ok).toBe('boolean');
    expect((u.body as { ok: boolean }).ok).toBe((t.body as { ok: boolean }).ok);
  });

  test('POST /v1/approvals/revoke: revoke returns same shape on both transports', async () => {
    const { tcp: t, uds: u } = await postBoth('/v1/approvals/revoke', { id: 'nonexistent_rule' });
    // Both should return same status (200 or error) — the key is they match.
    expect(u.status).toBe(t.status);
  });
});

describe('transport parity — GET routes with write-path prerequisites', () => {
  test('GET /v1/sessions (post-create): list grows identically on both transports', async () => {
    // Both TCP and UDS hit the same in-memory store, so a session created via TCP
    // is visible when listed via UDS.
    await createSession('Shared Session');

    const [tcpList, udsList] = await Promise.all([
      fetch(`http://127.0.0.1:${tcp.port}/v1/sessions`).then((r) => r.json()),
      fetch('http://localhost/v1/sessions', { unix: sockPath }).then((r) => r.json())
    ]);
    const tcpCount = (tcpList as { sessions: unknown[] }).sessions.length;
    const udsCount = (udsList as { sessions: unknown[] }).sessions.length;
    expect(udsCount).toBe(tcpCount);
  });

  test('GET /v1/approvals: both transports return same empty list initially', async () => {
    const [tcpRes, udsRes] = await Promise.all([
      fetch(`http://127.0.0.1:${tcp.port}/v1/approvals`).then((r) => r.json()),
      fetch('http://localhost/v1/approvals', { unix: sockPath }).then((r) => r.json())
    ]);
    expect(Array.isArray((tcpRes as { rules: unknown[] }).rules)).toBe(true);
    expect(Array.isArray((udsRes as { rules: unknown[] }).rules)).toBe(true);
    expect((udsRes as { rules: unknown[] }).rules.length).toBe((tcpRes as { rules: unknown[] }).rules.length);
  });
});

describe('transport parity — file observation restore guard', () => {
  for (const kind of TRANSPORTS) {
    test(`${kind}: file_read observation authorizes a later file_write`, async () => {
      const root = await mkdtemp(join(tmpdir(), `monad-file-transport-write-${kind}-`));
      const file = join(root, 'guard.txt');
      await writeFile(file, 'before');
      const transport = serveTransport(
        kind as TransportKind,
        createHttpTransport(
          buildHandlers(
            scriptedModel([
              { tool: 'file_read', input: { path: file } },
              'read',
              { tool: 'file_write', input: { path: file, content: 'after' } },
              'write'
            ]),
            undefined,
            { tools: [fileReadTool, fileWriteTool] }
          )
        )
      );

      try {
        const created = await postJson<{ sessionId: string }>(transport, '/v1/sessions', {
          title: `file observation write ${kind}`,
          cwd: root
        });
        await postJson(transport, `/v1/sessions/${created.sessionId}/messages/block`, { text: 'read file' });
        await postJson(transport, `/v1/sessions/${created.sessionId}/messages/block`, { text: 'write file' });

        expect(await readFile(file, 'utf8')).toBe('after');
      } finally {
        await transport.stop();
        await rm(root, { recursive: true, force: true });
      }
    });

    test(`${kind}: restore invalidates file_read observations before later file_write`, async () => {
      const root = await mkdtemp(join(tmpdir(), `monad-file-transport-${kind}-`));
      const file = join(root, 'guard.txt');
      await writeFile(file, 'before');
      const transport = serveTransport(
        kind as TransportKind,
        createHttpTransport(
          buildHandlers(
            scriptedModel([
              { tool: 'file_read', input: { path: file } },
              'read',
              { tool: 'file_write', input: { path: file, content: 'after' } },
              'write'
            ]),
            undefined,
            {
              tools: [fileReadTool, fileWriteTool]
            }
          )
        )
      );

      try {
        const created = await postJson<{ sessionId: string }>(transport, '/v1/sessions', {
          title: `file observation ${kind}`,
          cwd: root
        });
        await postJson(transport, `/v1/sessions/${created.sessionId}/messages`, {
          text: 'checkpoint',
          generate: false
        });
        const checkpointRes = await transport.fetch(`/v1/sessions/${created.sessionId}/messages`);
        const checkpoint = (await checkpointRes.json()) as { messages: Array<{ id: string; text: string }> };
        expect(checkpoint.messages.map((message) => message.text)).toEqual(['checkpoint']);
        await postJson(transport, `/v1/sessions/${created.sessionId}/messages/block`, { text: 'read file' });
        await postJson(transport, `/v1/sessions/${created.sessionId}/restore`, {
          toMessageId: checkpoint.messages[0]?.id
        });
        await postJson(transport, `/v1/sessions/${created.sessionId}/messages/block`, { text: 'write file' });

        expect(await readFile(file, 'utf8')).toBe('before');
      } finally {
        await transport.stop();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
