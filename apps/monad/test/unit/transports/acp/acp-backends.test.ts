import type { AgentContext } from '@agentclientprotocol/sdk';
import type { SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { isDelegableTool } from '@/capabilities/tools';
import { createAcpFsBackend, createAcpTerminalBackend } from '@/transports/acp/backends.ts';

const SID = 'ses_1' as SessionId;

test('ACP fs backend delegates reads/writes to the client over reverse-RPC', async () => {
  const calls: Record<string, unknown>[] = [];
  const conn = {
    async request(method: string, params: Record<string, unknown>) {
      calls.push({ m: method, ...params });
      if (method === 'fs/read_text_file') return { content: 'editor content' };
      return {};
    }
  } as unknown as AgentContext;

  const fs = createAcpFsBackend(conn, SID);
  expect(fs.delegated).toBe(true);

  expect(await fs.readTextFile('/p/a.ts', { offset: 5, limit: 10 })).toBe('editor content');
  const w = await fs.writeTextFile('/p/b.ts', 'data');
  expect(w).toEqual({ path: '/p/b.ts', bytesWritten: 4 });

  expect(calls).toEqual([
    { m: 'fs/read_text_file', sessionId: SID, path: '/p/a.ts', line: 5, limit: 10 },
    { m: 'fs/write_text_file', sessionId: SID, path: '/p/b.ts', content: 'data' }
  ]);
});

test('ACP terminal backend creates a client terminal and collects its output', async () => {
  const created: Record<string, unknown>[] = [];
  let released = false;
  const conn = {
    async request(method: string, params: Record<string, unknown>) {
      if (method === 'terminal/create') {
        created.push(params);
        return { terminalId: 'tid_1' };
      }
      if (method === 'terminal/wait_for_exit') return { exitCode: 0, signal: null };
      if (method === 'terminal/output')
        return { output: 'ran in editor', truncated: false, exitStatus: { exitCode: 0, signal: null } };
      if (method === 'terminal/release') {
        released = true;
        return {};
      }
      return {};
    }
  } as unknown as AgentContext;

  const terminal = createAcpTerminalBackend(conn, SID);
  expect(terminal.delegated).toBe(true);
  const r = await terminal.exec({ command: 'ls -a', cwd: '/proj' });
  expect(r).toEqual({ stdout: 'ran in editor', stderr: '', exitCode: 0, timedOut: false });
  expect(created[0]).toMatchObject({
    sessionId: SID,
    command: expect.stringMatching(/(?:^|[/\\])(?:sh|bash(?:\.exe)?)$/),
    args: ['-c', 'ls -a'],
    cwd: '/proj',
    outputByteLimit: 1024 * 1024
  });
  expect(released).toBe(true);
});

test('ACP terminal backend sets timedOut=true and exitCode=124 when the timer fires', async () => {
  let killed = false;
  let resolveWait!: () => void;
  const conn = {
    async request(method: string) {
      if (method === 'terminal/create') return { terminalId: 'tid_2' };
      if (method === 'terminal/wait_for_exit')
        return new Promise<{ exitCode: number | null; signal: null }>((r) => {
          resolveWait = () => r({ exitCode: null, signal: null });
        });
      if (method === 'terminal/output') return { output: 'partial', truncated: false, exitStatus: null };
      if (method === 'terminal/kill') {
        killed = true;
        resolveWait?.();
        return {};
      }
      return {};
    }
  } as unknown as AgentContext;

  const terminal = createAcpTerminalBackend(conn, SID);
  const r = await terminal.exec({ command: 'sleep 10', timeoutMs: 15 });
  expect(r.timedOut).toBe(true);
  expect(r.exitCode).toBe(124); // exitStatus null + timedOut → 124
  expect(killed).toBe(true);
});

test('isDelegableTool excludes daemon-host tools, keeps editor-routable ones', () => {
  for (const t of ['process_start', 'process_kill', 'code_execute', 'file_glob', 'file_grep']) {
    expect(isDelegableTool(t)).toBe(false);
  }
  for (const t of ['file_read', 'file_write', 'file_patch', 'shell_exec', 'web_fetch']) {
    expect(isDelegableTool(t)).toBe(true);
  }
});
