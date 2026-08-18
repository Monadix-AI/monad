import type { Dirent } from 'node:fs';
import type { MeshAgentProviderSessionLifecycleContext } from '@monad/sdk-atom';

import { readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type ClaudeLifecycleEnvironment = Record<string, string | undefined>;

interface ClaudeLifecycleProcess {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

type ClaudeLifecycleSpawn = (
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: 'ignore';
    stdout: 'pipe';
    stderr: 'pipe';
  }
) => ClaudeLifecycleProcess;

export interface ClaudeLifecycleOptions {
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

function claudeRoot(env: ClaudeLifecycleEnvironment): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
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

async function findClaudeSidecars(root: string, sessionId: string, transcripts: string[]): Promise<string[]> {
  const matches = transcripts.map((transcript) => join(dirname(transcript), sessionId));
  await Promise.all(
    ['file-history', 'session-env', 'tasks', 'debug'].map(async (name) => {
      const parent = join(root, name);
      let entries: Dirent<string>[];
      try {
        entries = await readdir(parent, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === sessionId || entry.name.startsWith(`${sessionId}.`)) matches.push(join(parent, entry.name));
      }
    })
  );
  return uniquePaths(matches);
}

export async function deleteClaudeCodeSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: ClaudeLifecycleOptions = {}
): Promise<void> {
  const spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions));
  const proc = spawn([context.agent.command, ...(context.agent.args ?? []), 'rm', context.providerSessionRef], {
    cwd: context.workingPath,
    env: { ...process.env, ...(context.agent.env ?? {}), ...(options.env ?? {}) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ]);
  const diagnostic = `${stdout}\n${stderr}`.trim();
  if (exitCode !== 0 && !/No job matching\b/.test(diagnostic)) {
    throw new Error(`claude rm failed: ${diagnostic || `exit code ${exitCode}`}`);
  }
  const env = { ...process.env, ...(context.agent.env ?? {}), ...(options.env ?? {}) };
  const root = claudeRoot(env);
  const transcripts = (
    await Promise.all(
      claudeProjectsRoots(env).map((projects) => findClaudeTranscriptFiles(projects, context.providerSessionRef))
    )
  ).flat();
  const sidecars = await findClaudeSidecars(root, context.providerSessionRef, transcripts);
  await Promise.all([
    ...transcripts.map((file) => rm(file, { force: true })),
    ...sidecars.map((path) => rm(path, { force: true, recursive: true }))
  ]);
}
