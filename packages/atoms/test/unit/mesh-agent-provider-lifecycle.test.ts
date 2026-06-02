import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { archiveClaudeCodeSession, deleteClaudeCodeSession } from '../../src/agent-adapters/claude-code/lifecycle.ts';
import {
  archiveCodexSession,
  deleteCodexSession,
  unarchiveCodexSession
} from '../../src/agent-adapters/codex/lifecycle.ts';
import { archiveGeminiSession, deleteGeminiSession } from '../../src/agent-adapters/gemini/lifecycle.ts';
import {
  archiveQwenSession,
  deleteQwenSession,
  unarchiveQwenSession
} from '../../src/agent-adapters/qwen/lifecycle.ts';

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

test('Qwen archive and unarchive move the exact transcript without changing contents', async () => {
  const dir = await tempDir();
  const chats = join(dir, 'projects', 'repo', 'chats');
  const archive = join(chats, 'archive');
  await mkdir(chats, { recursive: true });
  const target = join(chats, 'target.jsonl');
  const archivedTarget = join(archive, 'target.jsonl');
  const sibling = join(chats, 'sibling.jsonl');
  const contents = '{"type":"system","session_id":"qwen-session-1"}\n{"type":"message","content":"keep me"}\n';
  await writeFile(target, contents, 'utf8');
  await writeFile(sibling, '{"type":"system","session_id":"qwen-session-10"}\n', 'utf8');

  await archiveQwenSession(context('qwen-session-1'), { env: { QWEN_HOME: dir } });

  // presence-ok: archive moves the active transcript to the documented archive directory.
  await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(archivedTarget, 'utf8')).toBe(contents);
  await unarchiveQwenSession(context('qwen-session-1'), { env: { QWEN_HOME: dir } });

  expect(await readFile(target, 'utf8')).toBe(contents);
  // presence-ok: unarchive moves the archived transcript back to the active directory.
  await expect(stat(archivedTarget)).rejects.toMatchObject({ code: 'ENOENT' });
  await deleteQwenSession(context('qwen-session-1'), { env: { QWEN_HOME: dir } });

  // presence-ok: delete removes only the exact restored session transcript.
  await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readFile(sibling, 'utf8')).trim()).toBe('{"type":"system","session_id":"qwen-session-10"}');
});

test('Qwen unarchive refuses to overwrite an active transcript', async () => {
  const dir = await tempDir();
  const chats = join(dir, 'projects', 'repo', 'chats');
  const archive = join(chats, 'archive');
  await mkdir(archive, { recursive: true });
  await writeFile(join(chats, 'active.jsonl'), '{"type":"system","session_id":"qwen-conflict"}\n', 'utf8');
  await writeFile(join(archive, 'archived.jsonl'), '{"type":"system","session_id":"qwen-conflict"}\n', 'utf8');

  await expect(unarchiveQwenSession(context('qwen-conflict'), { env: { QWEN_HOME: dir } })).rejects.toThrow(
    'Qwen session qwen-conflict exists in both active and archive storage'
  );
  expect(await readFile(join(chats, 'active.jsonl'), 'utf8')).toBe('{"type":"system","session_id":"qwen-conflict"}\n');
  expect(await readFile(join(archive, 'archived.jsonl'), 'utf8')).toBe(
    '{"type":"system","session_id":"qwen-conflict"}\n'
  );
});
