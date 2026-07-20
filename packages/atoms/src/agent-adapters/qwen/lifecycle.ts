import type { Dirent } from 'node:fs';
import type { MeshAgentProviderSessionLifecycleContext } from '@monad/sdk-atom';

import { readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface QwenLifecycleProcess {
  exited: Promise<number>;
}

type QwenLifecycleSpawn = (
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: 'ignore';
    stdout: 'ignore';
    stderr: 'ignore';
  }
) => QwenLifecycleProcess;

export interface QwenLifecycleOptions {
  env?: Record<string, string | undefined>;
  spawn?: QwenLifecycleSpawn;
}

function qwenRoot(env: Record<string, string | undefined>): string {
  return env.QWEN_HOME?.trim() || join(homedir(), '.qwen');
}

function recordSessionId(record: unknown): string | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const sessionId = (record as { session_id?: unknown }).session_id;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

function transcriptContainsSessionId(contents: string, sessionId: string): boolean {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      if (recordSessionId(JSON.parse(trimmed)) === sessionId) return true;
    } catch {}
  }
  return false;
}

async function findQwenTranscriptFiles(root: string, sessionId: string): Promise<string[]> {
  const matches: string[] = [];
  async function visit(path: string): Promise<void> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(path, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath);
          return;
        }
        if (!entry.isFile() || (!entry.name.endsWith('.jsonl') && !entry.name.endsWith('.json'))) return;
        try {
          if (transcriptContainsSessionId(await readFile(entryPath, 'utf8'), sessionId)) matches.push(entryPath);
        } catch {
          return;
        }
      })
    );
  }
  await visit(root);
  return matches;
}

export function archiveQwenSession(
  _context: MeshAgentProviderSessionLifecycleContext,
  _options: QwenLifecycleOptions = {}
): Promise<void> {
  // Qwen Code does not document a non-interactive archive command; keep Monad archive local-only.
  return Promise.resolve();
}

export async function deleteQwenSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: QwenLifecycleOptions = {}
): Promise<void> {
  const files = await findQwenTranscriptFiles(
    qwenRoot({ ...process.env, ...(options.env ?? {}) }),
    context.providerSessionRef
  );
  await Promise.all(files.map((file) => rm(file, { force: true })));
}
