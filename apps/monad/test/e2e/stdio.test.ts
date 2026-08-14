// e2e: verifies the native JSON-RPC stdio wire path — a minimal daemon spawned as a child
// process (stdio.helper.ts), driven by raw NDJSON over its stdin/stdout. This is the exact
// framing path an embedded host (IDE, shell script, editor plugin) uses with --stdio, and
// cannot be covered by the in-process HTTP transport tests.

import { afterAll, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const helper = resolve(import.meta.dir, 'stdio.helper.ts');
const STDIO_E2E_TIMEOUT_MS = 30_000;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

async function spawnStdioHelper() {
  const proc = Bun.spawn(['bun', helper], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: { ...Bun.env, NODE_ENV: 'test' }
  });

  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let nextId = 0;

  async function readLine(): Promise<string> {
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) return line;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stdio stdout closed unexpectedly');
      buf += dec.decode(value);
    }
  }

  async function call(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    const id = ++nextId;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    await proc.stdin.flush();
    return JSON.parse(await readLine()) as JsonRpcResponse;
  }

  async function close(): Promise<void> {
    proc.stdin.end();
    await proc.exited;
    reader.releaseLock();
  }

  const ready = JSON.parse(await readLine()) as { ready?: unknown };
  if (ready.ready !== true) throw new Error('stdio helper did not become ready');

  return { call, close };
}

const stdio = await spawnStdioHelper();

afterAll(() => stdio.close());

test(
  'stdio JSON-RPC: sessions.create → sessions.get → sessions.list round-trip',
  async () => {
    // Create a session.
    const created = await stdio.call('sessions.create', { title: 'stdio-test' });
    expect(created.error).toBeUndefined();
    const { sessionId } = created.result as { sessionId: string };
    expect(sessionId).toMatch(/^ses_/);

    // Fetch by ID.
    const got = await stdio.call('sessions.get', { id: sessionId });
    expect(got.error).toBeUndefined();
    const session = got.result as { session: { id: string; title: string } };
    expect(session.session.id).toBe(sessionId);
    expect(session.session.title).toBe('stdio-test');

    // List includes the new session.
    const listed = await stdio.call('sessions.list', {});
    expect(listed.error).toBeUndefined();
    const { sessions } = listed.result as { sessions: { id: string }[] };
    expect(sessions.some((s) => s.id === sessionId)).toBe(true);
  },
  STDIO_E2E_TIMEOUT_MS
);

test(
  'stdio JSON-RPC: unknown method returns -32601 METHOD_NOT_FOUND',
  async () => {
    const res = await stdio.call('no.such.method', {});
    expect(res.result).toBeUndefined();
    expect(res.error?.code).toBe(-32601);
  },
  STDIO_E2E_TIMEOUT_MS
);

test(
  'stdio JSON-RPC: invalid params returns -32602 INVALID_PARAMS',
  async () => {
    // sessions.create requires a `title` field — omitting it should fail schema validation.
    const res = await stdio.call('sessions.create', {});
    expect(res.result).toBeUndefined();
    expect(res.error?.code).toBe(-32602);
  },
  STDIO_E2E_TIMEOUT_MS
);

test(
  'stdio JSON-RPC: multiple sequential requests share one connection',
  async () => {
    // Fire three creates in order — stdio is sequential, responses must match requests.
    const titles = ['alpha', 'beta', 'gamma'];
    const ids: string[] = [];
    for (const title of titles) {
      const res = await stdio.call('sessions.create', { title });
      expect(res.error).toBeUndefined();
      ids.push((res.result as { sessionId: string }).sessionId);
    }

    // All three IDs are distinct and valid.
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => id.startsWith('ses_'))).toBe(true);
  },
  STDIO_E2E_TIMEOUT_MS
);
