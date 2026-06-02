import type { Dirent } from 'node:fs';
import type { MeshAgentProviderSessionLifecycleContext } from '@monad/sdk-atom';

import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

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

type QwenTranscriptLocation = {
  active: string;
  archived: string;
  state: 'active' | 'archived';
};

function qwenTranscriptLocation(file: string): QwenTranscriptLocation | undefined {
  const parent = dirname(file);
  if (basename(parent) === 'chats') {
    return {
      active: file,
      archived: join(parent, 'archive', basename(file)),
      state: 'active'
    };
  }
  if (basename(parent) === 'archive' && basename(dirname(parent)) === 'chats') {
    return {
      active: join(dirname(parent), basename(file)),
      archived: file,
      state: 'archived'
    };
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function moveQwenSession(
  context: MeshAgentProviderSessionLifecycleContext,
  destination: 'active' | 'archived',
  options: QwenLifecycleOptions
): Promise<void> {
  const files = await findQwenTranscriptFiles(
    qwenRoot({ ...process.env, ...(options.env ?? {}) }),
    context.providerSessionRef
  );
  const locations = files.flatMap((file) => {
    const location = qwenTranscriptLocation(file);
    return location ? [location] : [];
  });
  const active = locations.filter((location) => location.state === 'active');
  const archived = locations.filter((location) => location.state === 'archived');
  if (active.length > 0 && archived.length > 0) {
    throw new Error(`Qwen session ${context.providerSessionRef} exists in both active and archive storage`);
  }

  const sources = destination === 'active' ? archived : active;
  if (sources.length === 0) return;
  const moves = sources.map((location) => ({
    source: destination === 'active' ? location.archived : location.active,
    target: destination === 'active' ? location.active : location.archived
  }));
  for (const move of moves) {
    if (await pathExists(move.target)) {
      throw new Error(`Qwen session ${context.providerSessionRef} destination already exists: ${move.target}`);
    }
  }
  if (destination === 'archived') {
    await Promise.all(moves.map((move) => mkdir(dirname(move.target), { recursive: true })));
  }
  await Promise.all(moves.map((move) => rename(move.source, move.target)));
}

export function archiveQwenSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: QwenLifecycleOptions = {}
): Promise<void> {
  return moveQwenSession(context, 'archived', options);
}

export function unarchiveQwenSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: QwenLifecycleOptions = {}
): Promise<void> {
  return moveQwenSession(context, 'active', options);
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
