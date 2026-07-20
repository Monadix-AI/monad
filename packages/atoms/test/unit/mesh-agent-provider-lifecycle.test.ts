import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { archiveClaudeCodeSession, deleteClaudeCodeSession } from '../../src/agent-adapters/claude-code/lifecycle.ts';
import { archiveCodexSession, deleteCodexSession } from '../../src/agent-adapters/codex/lifecycle.ts';
import { archiveGeminiSession, deleteGeminiSession } from '../../src/agent-adapters/gemini/lifecycle.ts';
import { archiveQwenSession, deleteQwenSession } from '../../src/agent-adapters/qwen/lifecycle.ts';

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'monad-provider-lifecycle-'));
  tempRoots.push(path);
  return path;
}

function context(providerSessionRef = 'thread_test123') {
  return {
    meshSessionId: 'mesh_lifecycle',
    transcriptTargetId: 'ses_lifecycle',
    agentName: 'pmem_agent',
    providerSessionRef,
    workingPath: '/tmp/project'
  };
}

test('Codex lifecycle hooks call provider app-server thread methods', async () => {
  const argvCalls: string[][] = [];
  const requests: unknown[] = [];
  const response = new TextEncoder().encode('{"id":2,"result":{}}\n');
  const spawn = (argv: string[]) => {
    argvCalls.push(argv);
    return {
      stdin: {
        write(chunk: string) {
          requests.push(JSON.parse(chunk.trim()) as unknown);
        }
      },
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(response);
          controller.close();
        }
      }),
      kill() {}
    };
  };

  await archiveCodexSession(context('thread_archive'), {
    spawn,
    timeoutMs: 500
  });
  await deleteCodexSession(context('thread_delete'), {
    spawn,
    timeoutMs: 500
  });

  expect(argvCalls).toEqual([
    ['codex', 'app-server', '--stdio'],
    ['codex', 'app-server', '--stdio']
  ]);
  expect(requests).toEqual([
    { method: 'initialize', id: 1, params: { clientInfo: { name: 'monad', version: '0' }, capabilities: null } },
    { method: 'initialized' },
    { method: 'thread/archive', id: 2, params: { threadId: 'thread_archive' } },
    { method: 'initialize', id: 1, params: { clientInfo: { name: 'monad', version: '0' }, capabilities: null } },
    { method: 'initialized' },
    { method: 'thread/delete', id: 2, params: { threadId: 'thread_delete' } }
  ]);
});

test('Claude archive hook removes the provider background session from the CLI list', async () => {
  const argvCalls: string[][] = [];

  await archiveClaudeCodeSession(context('claude-session-1'), {
    spawn: (argv) => {
      argvCalls.push(argv);
      return { exited: Promise.resolve(0) };
    }
  });

  expect(argvCalls).toEqual([['claude', 'rm', 'claude-session-1']]);
});

test('Claude delete hook removes only local transcripts for the exact provider session id', async () => {
  const dir = await tempDir();
  const projects = join(dir, 'projects', 'repo');
  await mkdir(projects, { recursive: true });
  const target = join(projects, 'target.jsonl');
  const sibling = join(projects, 'sibling.jsonl');
  await writeFile(target, '{"type":"system","subtype":"init","session_id":"claude-session-1"}\n', 'utf8');
  await writeFile(sibling, '{"type":"system","subtype":"init","session_id":"claude-session-10"}\n', 'utf8');

  await deleteClaudeCodeSession(context('claude-session-1'), { env: { CLAUDE_CONFIG_DIR: dir } });

  await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readFile(sibling, 'utf8')).trim()).toBe(
    '{"type":"system","subtype":"init","session_id":"claude-session-10"}'
  );
});

test('Gemini archive is explicit no-op and delete uses the provider session CLI', async () => {
  const argvCalls: string[][] = [];

  await archiveGeminiSession(context('gemini-session-1'), {
    spawn: (argv) => {
      argvCalls.push(argv);
      return { exited: Promise.resolve(0) };
    }
  });
  await deleteGeminiSession(context('gemini-session-1'), {
    spawn: (argv) => {
      argvCalls.push(argv);
      return { exited: Promise.resolve(0) };
    }
  });

  expect(argvCalls).toEqual([['gemini', '--delete-session', 'gemini-session-1']]);
});

test('Qwen archive is explicit no-op and delete removes only exact local session transcripts', async () => {
  const argvCalls: string[][] = [];
  const dir = await tempDir();
  const nested = join(dir, 'sessions', 'repo');
  await mkdir(nested, { recursive: true });
  const target = join(nested, 'target.jsonl');
  const sibling = join(nested, 'sibling.jsonl');
  await writeFile(target, '{"type":"system","session_id":"qwen-session-1"}\n', 'utf8');
  await writeFile(sibling, '{"type":"system","session_id":"qwen-session-10"}\n', 'utf8');

  await archiveQwenSession(context('qwen-session-1'), {
    spawn: (argv) => {
      argvCalls.push(argv);
      return { exited: Promise.resolve(0) };
    }
  });
  await deleteQwenSession(context('qwen-session-1'), { env: { QWEN_HOME: dir } });

  expect(argvCalls).toEqual([]);
  await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readFile(sibling, 'utf8')).trim()).toBe('{"type":"system","session_id":"qwen-session-10"}');
});
