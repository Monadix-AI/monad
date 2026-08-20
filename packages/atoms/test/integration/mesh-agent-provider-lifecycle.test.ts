import type { MeshAgentProviderSessionLifecycleContext } from '@monad/sdk-atom';

import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deleteAntigravitySession } from '../../src/agent-adapters/antigravity/lifecycle.ts';
import { deleteClaudeCodeSession } from '../../src/agent-adapters/claude-code/lifecycle.ts';
import {
  archiveCodexSession,
  deleteCodexSession,
  unarchiveCodexSession
} from '../../src/agent-adapters/codex/lifecycle.ts';
import { deleteGeminiSession } from '../../src/agent-adapters/gemini/lifecycle.ts';
import { deleteHermesSession } from '../../src/agent-adapters/hermes/lifecycle.ts';
import {
  archiveMonadSession,
  deleteMonadSession,
  unarchiveMonadSession
} from '../../src/agent-adapters/monad/lifecycle.ts';
import {
  archiveQwenSession,
  deleteQwenSession,
  unarchiveQwenSession
} from '../../src/agent-adapters/qwen/lifecycle.ts';

const tempRoots: string[] = [];

function bytes(contents = ''): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (contents) controller.enqueue(new TextEncoder().encode(contents));
      controller.close();
    }
  });
}

afterAll(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'monad-provider-lifecycle-'));
  tempRoots.push(path);
  return path;
}

function context(
  providerSessionRef = 'thread_test123',
  agent: Partial<MeshAgentProviderSessionLifecycleContext['agent']> = {}
): MeshAgentProviderSessionLifecycleContext {
  return {
    meshSessionId: 'mesh_lifecycle',
    transcriptTargetId: 'ses_lifecycle',
    agentName: 'pmem_agent',
    agent: {
      name: 'pmem_agent',
      provider: 'codex',
      productIcon: 'codex',
      command: 'codex',
      args: [],
      enabled: true,
      allowAutopilot: false,
      approvalOwnership: 'provider-owned',
      ...agent
    },
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
  await unarchiveCodexSession(context('thread_unarchive'), {
    spawn,
    timeoutMs: 500
  });
  await deleteCodexSession(context('thread_delete'), {
    spawn,
    timeoutMs: 500
  });

  expect(argvCalls).toEqual([
    ['codex', 'app-server', '--stdio'],
    ['codex', 'app-server', '--stdio'],
    ['codex', 'app-server', '--stdio']
  ]);
  expect(requests).toEqual([
    { method: 'initialize', id: 1, params: { clientInfo: { name: 'monad', version: '0' }, capabilities: null } },
    { method: 'initialized' },
    { method: 'thread/archive', id: 2, params: { threadId: 'thread_archive' } },
    { method: 'initialize', id: 1, params: { clientInfo: { name: 'monad', version: '0' }, capabilities: null } },
    { method: 'initialized' },
    { method: 'thread/unarchive', id: 2, params: { threadId: 'thread_unarchive' } },
    { method: 'initialize', id: 1, params: { clientInfo: { name: 'monad', version: '0' }, capabilities: null } },
    { method: 'initialized' },
    { method: 'thread/delete', id: 2, params: { threadId: 'thread_delete' } }
  ]);
});

test('Claude delete tolerates a non-background session and removes its exact local state', async () => {
  const dir = await tempDir();
  const projects = join(dir, 'projects', 'repo');
  const targetSidecar = join(projects, 'claude-session-1', 'tool-results');
  const fileHistory = join(dir, 'file-history', 'claude-session-1');
  const tasks = join(dir, 'tasks', 'claude-session-1');
  await Promise.all([
    mkdir(targetSidecar, { recursive: true }),
    mkdir(fileHistory, { recursive: true }),
    mkdir(tasks, { recursive: true })
  ]);
  const target = join(projects, 'target.jsonl');
  const sibling = join(projects, 'sibling.jsonl');
  await Promise.all([
    writeFile(target, '{"type":"system","subtype":"init","session_id":"claude-session-1"}\n', 'utf8'),
    writeFile(sibling, '{"type":"system","subtype":"init","session_id":"claude-session-10"}\n', 'utf8'),
    writeFile(join(targetSidecar, 'result.txt'), 'target', 'utf8'),
    writeFile(join(fileHistory, 'snapshot'), 'target', 'utf8'),
    writeFile(join(tasks, 'task.json'), 'target', 'utf8')
  ]);

  const argvCalls: string[][] = [];
  await deleteClaudeCodeSession(
    context('claude-session-1', { command: 'claude-custom', args: ['--profile', 'work'] }),
    {
      env: { CLAUDE_CONFIG_DIR: dir },
      spawn: (argv) => {
        argvCalls.push(argv);
        return { exited: Promise.resolve(1), stdout: bytes(), stderr: bytes("No job matching 'claude-session-1'\n") };
      }
    }
  );

  expect(argvCalls).toEqual([['claude-custom', '--profile', 'work', 'rm', 'claude-session-1']]);
  const removedCodes = await Promise.all(
    [target, join(projects, 'claude-session-1'), fileHistory, tasks].map(async (path) =>
      stat(path).then(
        () => 'present',
        (error: NodeJS.ErrnoException) => error.code
      )
    )
  );
  expect({ removedCodes, sibling: (await readFile(sibling, 'utf8')).trim() }).toEqual({
    removedCodes: ['ENOENT', 'ENOENT', 'ENOENT', 'ENOENT'],
    sibling: '{"type":"system","subtype":"init","session_id":"claude-session-10"}'
  });
});

test('Gemini delete uses the configured provider session CLI', async () => {
  const argvCalls: string[][] = [];

  await deleteGeminiSession(context('gemini-session-1', { command: 'gemini-custom', args: ['--profile', 'work'] }), {
    spawn: (argv) => {
      argvCalls.push(argv);
      return { exited: Promise.resolve(0) };
    }
  });

  expect(argvCalls).toEqual([['gemini-custom', '--profile', 'work', '--delete-session', 'gemini-session-1']]);
});

test('Antigravity delete removes one conversation from storage, summaries, and caches', async () => {
  const root = await tempDir();
  const conversations = join(root, 'conversations');
  const cache = join(root, 'cache');
  await mkdir(conversations, { recursive: true });
  await mkdir(cache, { recursive: true });
  const target = 'antigravity-session-1';
  const sibling = 'antigravity-session-10';
  await Promise.all([
    writeFile(join(conversations, `${target}.db`), 'target', 'utf8'),
    writeFile(join(conversations, `${target}.db-wal`), 'wal', 'utf8'),
    writeFile(join(conversations, `${sibling}.db`), 'sibling', 'utf8'),
    writeFile(
      join(cache, 'conversation_metadata.json'),
      JSON.stringify({ conversations: { [target]: { title: 'target' }, [sibling]: { title: 'sibling' } } }),
      'utf8'
    ),
    writeFile(
      join(cache, 'last_conversations.json'),
      JSON.stringify({ '/workspace/target': target, '/workspace/sibling': sibling }),
      'utf8'
    )
  ]);
  const summaries = new Database(join(root, 'conversation_summaries.db'), { create: true, strict: true });
  summaries.run('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL)');
  summaries.query('INSERT INTO conversation_summaries VALUES (?, ?)').run(target, 'target');
  summaries.query('INSERT INTO conversation_summaries VALUES (?, ?)').run(sibling, 'sibling');
  summaries.close();

  await deleteAntigravitySession(context(target), { root });

  await expect(stat(join(conversations, `${target}.db`))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(conversations, `${target}.db-wal`))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(conversations, `${sibling}.db`), 'utf8')).toBe('sibling');
  const remaining = new Database(join(root, 'conversation_summaries.db'), { create: false, strict: true });
  expect(remaining.query('SELECT conversation_id, title FROM conversation_summaries').all()).toEqual([
    { conversation_id: sibling, title: 'sibling' }
  ]);
  remaining.close();
  expect(JSON.parse(await readFile(join(cache, 'conversation_metadata.json'), 'utf8'))).toEqual({
    conversations: { [sibling]: { title: 'sibling' } }
  });
  expect(JSON.parse(await readFile(join(cache, 'last_conversations.json'), 'utf8'))).toEqual({
    '/workspace/sibling': sibling
  });
});

test('Antigravity delete restores staged files when its metadata transaction fails', async () => {
  const root = await tempDir();
  const conversations = join(root, 'conversations');
  const cache = join(root, 'cache');
  await Promise.all([mkdir(conversations, { recursive: true }), mkdir(cache, { recursive: true })]);
  const target = 'antigravity-session-rollback';
  const database = join(conversations, `${target}.db`);
  const metadata = join(cache, 'conversation_metadata.json');
  await Promise.all([
    writeFile(database, 'target', 'utf8'),
    writeFile(metadata, JSON.stringify({ conversations: { [target]: { title: 'target' } } }), 'utf8'),
    writeFile(join(cache, 'last_conversations.json'), JSON.stringify({ '/workspace/target': target }), 'utf8')
  ]);
  const summaries = new Database(join(root, 'conversation_summaries.db'), { create: true, strict: true });
  summaries.run('CREATE TABLE unrelated (id TEXT PRIMARY KEY)');
  summaries.close();

  await expect(deleteAntigravitySession(context(target), { root })).rejects.toThrow('conversation_summaries');
  expect({
    database: await readFile(database, 'utf8'),
    metadata: JSON.parse(await readFile(metadata, 'utf8'))
  }).toEqual({
    database: 'target',
    metadata: { conversations: { [target]: { title: 'target' } } }
  });
});

test('Hermes delete and Monad lifecycle use their configured non-interactive CLI contracts', async () => {
  const calls: string[][] = [];
  const spawn = (argv: string[]) => {
    calls.push(argv);
    return { exited: Promise.resolve(0) };
  };

  await deleteHermesSession(context('hermes-session', { command: 'hermes-custom', args: ['--profile', 'work'] }), {
    spawn
  });
  await deleteMonadSession(context('ses_provider', { command: 'monad-custom', args: ['--server', 'local'] }), {
    spawn
  });
  await archiveMonadSession(context('ses_provider', { command: 'monad-custom', args: ['--server', 'local'] }), {
    spawn
  });
  await unarchiveMonadSession(context('ses_provider', { command: 'monad-custom', args: ['--server', 'local'] }), {
    spawn
  });

  expect(calls).toEqual([
    ['hermes-custom', '--profile', 'work', 'sessions', 'delete', 'hermes-session', '--yes'],
    ['monad-custom', '--server', 'local', 'session', 'rm', 'ses_provider'],
    ['monad-custom', '--server', 'local', 'session', 'archive', 'ses_provider'],
    ['monad-custom', '--server', 'local', 'session', 'unarchive', 'ses_provider']
  ]);
});

test('Qwen lifecycle starts the official daemon and calls its session routes', async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const spawn = () => {
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    return {
      exited,
      stdout: bytes('qwen serve listening on http://127.0.0.1:43123 (mode=http-bridge)\n'),
      stderr: bytes(),
      kill: () => resolveExit(0)
    };
  };
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    if (url.endsWith('/capabilities')) return new Response(JSON.stringify({ features: ['session_archive'] }));
    const action = url.split('/').at(-1);
    const field = action === 'delete' ? 'removed' : action === 'archive' ? 'archived' : 'unarchived';
    return new Response(JSON.stringify({ [field]: ['qwen-session-1'], notFound: [], errors: [] }));
  };

  await archiveQwenSession(context('qwen-session-1'), { spawn, fetch: request });
  await unarchiveQwenSession(context('qwen-session-1'), { spawn, fetch: request });
  await deleteQwenSession(context('qwen-session-1'), { spawn, fetch: request });

  expect(calls).toEqual([
    { url: 'http://127.0.0.1:43123/capabilities' },
    { url: 'http://127.0.0.1:43123/sessions/archive', body: '{"sessionIds":["qwen-session-1"]}' },
    { url: 'http://127.0.0.1:43123/capabilities' },
    { url: 'http://127.0.0.1:43123/sessions/unarchive', body: '{"sessionIds":["qwen-session-1"]}' },
    { url: 'http://127.0.0.1:43123/sessions/delete', body: '{"sessionIds":["qwen-session-1"]}' }
  ]);
});

test('Qwen lifecycle propagates provider conflicts', async () => {
  const spawn = () => {
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    return {
      exited,
      stdout: bytes('qwen serve listening on http://127.0.0.1:43123\n'),
      stderr: bytes(),
      kill: () => resolveExit(0)
    };
  };
  const request = async (input: string | URL | Request) =>
    String(input).endsWith('/capabilities')
      ? new Response(JSON.stringify({ features: ['session_archive'] }))
      : new Response(
          JSON.stringify({ unarchived: [], alreadyActive: [], notFound: [], errors: [{ error: 'conflict' }] })
        );

  await expect(unarchiveQwenSession(context('qwen-conflict'), { spawn, fetch: request })).rejects.toThrow(
    'qwen sessions unarchive failed'
  );
});
