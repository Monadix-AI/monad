// e2e: verifies the native JSON-RPC stdio wire path — a minimal daemon spawned as a child
// process (stdio.helper.ts), driven by raw NDJSON over its stdin/stdout. This is the exact
// framing path an embedded host (IDE, shell script, editor plugin) uses with --stdio, and
// cannot be covered by the in-process HTTP transport tests.

import { afterEach, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const helper = resolve(import.meta.dir, 'stdio.helper.ts');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function spawnStdioHelper() {
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

  return { proc, call };
}

const procs: ReturnType<typeof Bun.spawn>[] = [];

afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
});

test('stdio JSON-RPC: sessions.create → sessions.get → sessions.list round-trip', async () => {
  const { proc, call } = spawnStdioHelper();
  procs.push(proc);

  // Create a session.
  const created = await call('sessions.create', { title: 'stdio-test' });
  expect(created.error).toBeUndefined();
  const { sessionId } = created.result as { sessionId: string };
  expect(sessionId).toMatch(/^ses_/);

  // Fetch by ID.
  const got = await call('sessions.get', { id: sessionId });
  expect(got.error).toBeUndefined();
  const session = got.result as { session: { id: string; title: string } };
  expect(session.session.id).toBe(sessionId);
  expect(session.session.title).toBe('stdio-test');

  // List includes the new session.
  const listed = await call('sessions.list', {});
  expect(listed.error).toBeUndefined();
  const { sessions } = listed.result as { sessions: { id: string }[] };
  expect(sessions.some((s) => s.id === sessionId)).toBe(true);
}, 10_000);

test('stdio JSON-RPC: unknown method returns -32601 METHOD_NOT_FOUND', async () => {
  const { proc, call } = spawnStdioHelper();
  procs.push(proc);

  const res = await call('no.such.method', {});
  expect(res.result).toBeUndefined();
  expect(res.error?.code).toBe(-32601);
}, 10_000);

test('stdio JSON-RPC: invalid params returns -32602 INVALID_PARAMS', async () => {
  const { proc, call } = spawnStdioHelper();
  procs.push(proc);

  // sessions.create requires a `title` field — omitting it should fail schema validation.
  const res = await call('sessions.create', {});
  expect(res.result).toBeUndefined();
  expect(res.error?.code).toBe(-32602);
}, 10_000);

test('stdio JSON-RPC: multiple sequential requests share one connection', async () => {
  const { proc, call } = spawnStdioHelper();
  procs.push(proc);

  // Fire three creates in order — stdio is sequential, responses must match requests.
  const titles = ['alpha', 'beta', 'gamma'];
  const ids: string[] = [];
  for (const title of titles) {
    const res = await call('sessions.create', { title });
    expect(res.error).toBeUndefined();
    ids.push((res.result as { sessionId: string }).sessionId);
  }

  // All three IDs are distinct and valid.
  expect(new Set(ids).size).toBe(3);
  expect(ids.every((id) => id.startsWith('ses_'))).toBe(true);
}, 10_000);
