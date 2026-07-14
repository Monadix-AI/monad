// e2e: verifies the real stdio ACP wire path — a minimal ACP agent spawned as a child process
// (acp-stdio.helper.ts), driven by the SDK's client() API over its stdin/stdout. This
// is the exact ndJson framing path an editor (e.g. Zed) uses and cannot be covered by the
// in-process acp-transport tests.

import type { RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk';

import { afterEach, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { client as acpClient, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const helper = resolve(import.meta.dir, 'acp-stdio.helper.ts');

function spawnAcpHelper() {
  const proc = Bun.spawn(['bun', helper], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: { ...Bun.env, NODE_ENV: 'test' }
  });

  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      proc.stdin.write(chunk);
      proc.stdin.flush();
    },
    close() {
      proc.stdin.end();
    }
  });

  const updates: SessionNotification[] = [];
  const app = acpClient()
    .onNotification('session/update', ({ params }) => {
      updates.push(params);
    })
    .onRequest(
      'session/request_permission',
      (): RequestPermissionResponse => ({
        outcome: { outcome: 'selected', optionId: 'allow' }
      })
    );

  const stream = ndJsonStream(output, proc.stdout);
  return { proc, app, stream, updates };
}

const procs: ReturnType<typeof Bun.spawn>[] = [];

afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
});

test('stdio ACP: initialize → newSession → prompt → forkSession over real child process', async () => {
  const { proc, app, stream, updates } = spawnAcpHelper();
  procs.push(proc);

  await app.connectWith(stream, async (ctx) => {
    const init = await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.agentInfo?.name).toBe('monad');

    const { sessionId } = await ctx.request('session/new', { cwd: process.cwd(), mcpServers: [] });
    expect(sessionId).toMatch(/^ses_/);

    const res = await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] });
    expect(res.stopReason).toBe('end_turn');

    const text = updates
      .filter((u) => u.update.sessionUpdate === 'agent_message_chunk')
      .map((u) => (u.update as { content: { text: string } }).content.text)
      .join('');
    expect(text.length).toBeGreaterThan(0);

    const forked = await ctx.request('session/fork', { sessionId, cwd: process.cwd(), mcpServers: [] });
    expect(forked.sessionId).toMatch(/^ses_/);
    expect(forked.sessionId).not.toBe(sessionId);
  });
}, 20_000);
