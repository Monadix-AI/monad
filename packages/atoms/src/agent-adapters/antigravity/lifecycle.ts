import type { MeshAgentProviderSessionLifecycleContext } from '@monad/sdk-atom';

import { Database } from 'bun:sqlite';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

type JsonRecord = Record<string, unknown>;

export interface AntigravityLifecycleOptions {
  root?: string;
}

function antigravityRoot(options: AntigravityLifecycleOptions): string {
  return options.root ?? join(homedir(), '.gemini', 'antigravity-cli');
}

function assertConversationId(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid Antigravity conversation id: ${value}`);
}

type JsonUpdate = { path: string; original: string; next: string };

async function prepareJsonUpdate(
  path: string,
  update: (value: JsonRecord) => boolean
): Promise<JsonUpdate | undefined> {
  let original: string;
  let value: unknown;
  try {
    original = await readFile(path, 'utf8');
    value = JSON.parse(original);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Antigravity cache file: ${path}`);
  }
  if (!update(value as JsonRecord)) return undefined;
  return { path, original, next: `${JSON.stringify(value)}\n` };
}

async function writeJsonUpdate(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function deleteAntigravitySession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: AntigravityLifecycleOptions = {}
): Promise<void> {
  const conversationId = context.providerSessionRef;
  assertConversationId(conversationId);
  const root = antigravityRoot(options);
  const conversations = join(root, 'conversations');
  const summariesPath = join(root, 'conversation_summaries.db');
  const updates = (
    await Promise.all([
      prepareJsonUpdate(join(root, 'cache', 'conversation_metadata.json'), (cache) => {
        const entries = cache.conversations;
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return false;
        return delete (entries as JsonRecord)[conversationId];
      }),
      prepareJsonUpdate(join(root, 'cache', 'last_conversations.json'), (cache) => {
        let changed = false;
        for (const [workspace, value] of Object.entries(cache)) {
          if (value !== conversationId) continue;
          delete cache[workspace];
          changed = true;
        }
        return changed;
      })
    ])
  ).filter((update): update is JsonUpdate => update !== undefined);
  const files = ['db', 'db-shm', 'db-wal', 'pb'].map((extension) =>
    join(conversations, `${conversationId}.${extension}`)
  );
  const staged = (
    await Promise.all(
      files.map(async (path) => {
        if (!(await exists(path))) return undefined;
        const temporary = `${path}.monad-delete-${process.pid}`;
        await rename(path, temporary);
        return { path, temporary };
      })
    )
  ).filter((entry): entry is { path: string; temporary: string } => entry !== undefined);
  const summaries = (await Bun.file(summariesPath).exists())
    ? new Database(summariesPath, { create: false, strict: true })
    : undefined;
  try {
    summaries?.exec('BEGIN IMMEDIATE');
    summaries?.query('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(conversationId);
    await Promise.all(updates.map((update) => writeJsonUpdate(update.path, update.next)));
    summaries?.exec('COMMIT');
    await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })));
  } catch (error) {
    try {
      summaries?.exec('ROLLBACK');
    } catch {}
    await Promise.allSettled([
      ...updates.map((update) => writeJsonUpdate(update.path, update.original)),
      ...staged.map(({ path, temporary }) => rename(temporary, path))
    ]);
    throw error;
  } finally {
    summaries?.close();
  }
}
