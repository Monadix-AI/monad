import type { Dirent } from 'node:fs';
import type { MeshAgentProviderSessionLifecycleContext } from '@monad/sdk-atom';

import { readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

type ClaudeLifecycleEnvironment = Record<string, string | undefined>;

interface ClaudeLifecycleProcess {
  exited: Promise<number>;
}

type ClaudeLifecycleSpawn = (
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: 'ignore';
    stdout: 'ignore';
    stderr: 'ignore';
  }
) => ClaudeLifecycleProcess;

export interface ClaudeLifecycleOptions {
  command?: string;
  commandArgs?: string[];
  env?: ClaudeLifecycleEnvironment;
  spawn?: ClaudeLifecycleSpawn;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function claudeProjectsRoots(env: ClaudeLifecycleEnvironment): string[] {
  const configuredDir = env.CLAUDE_CONFIG_DIR?.trim();
  const defaultDir = join(homedir(), '.claude');
  return uniquePaths([join(configuredDir || defaultDir, 'projects')]);
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

async function findClaudeTranscriptFiles(root: string, sessionId: string): Promise<string[]> {
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
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return;
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

export async function archiveClaudeCodeSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: ClaudeLifecycleOptions = {}
): Promise<void> {
  const spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions));
  const proc = spawn([options.command ?? 'claude', ...(options.commandArgs ?? []), 'rm', context.providerSessionRef], {
    cwd: context.workingPath,
    env: { ...process.env, ...(options.env ?? {}) },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore'
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`claude rm failed with exit code ${exitCode}`);
}

export async function deleteClaudeCodeSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: ClaudeLifecycleOptions = {}
): Promise<void> {
  const roots = claudeProjectsRoots({ ...process.env, ...(options.env ?? {}) });
  const files = (
    await Promise.all(roots.map((root) => findClaudeTranscriptFiles(root, context.providerSessionRef)))
  ).flat();
  await Promise.all(files.map((file) => rm(file, { force: true })));
}
