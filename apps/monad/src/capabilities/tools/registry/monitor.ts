import type { Tool, ToolContext } from '../types.ts';
import type { ToolModule } from './contract.ts';

import { stat } from 'node:fs/promises';
import { assertPathWithinRoots, ToolSecurityError } from '@monad/sandbox';
import { z } from 'zod';

import { gatePathAccess } from '../approval/path-gate.ts';
import { createSandboxBackends, resolveReal } from '../backends.ts';
import { toolResult } from '../types.ts';
import { watchBackgroundProcess } from './process.ts';

const MAX_WAIT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 100;
const MAX_PATTERN = 2000;

function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

const monitorWatchInput = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('process'),
    id: z.string().min(1),
    pattern: z.string().min(1).max(MAX_PATTERN).optional(),
    match: z.enum(['literal', 'regex']).optional(),
    stripAnsi: z.boolean().optional(),
    status: z.enum(['running', 'exited', 'killed']).optional(),
    timeoutMs: z.number().int().min(1).max(MAX_WAIT_MS).optional()
  }),
  z
    .object({
      target: z.literal('file'),
      path: z.string().min(1),
      condition: z.enum(['exists', 'changes', 'contains']),
      pattern: z.string().min(1).max(MAX_PATTERN).optional(),
      match: z.enum(['literal', 'regex']).optional(),
      baseHash: z.string().optional(),
      timeoutMs: z.number().int().min(1).max(MAX_WAIT_MS).optional(),
      intervalMs: z.number().int().min(10).max(10_000).optional()
    })
    .refine((value) => value.condition !== 'contains' || value.pattern !== undefined, {
      message: 'pattern is required when condition is "contains"'
    })
]);

type MonitorWatchInput = z.infer<typeof monitorWatchInput>;

type FileWatchInput = Extract<MonitorWatchInput, { target: 'file' }>;

interface FileSnapshot {
  exists: boolean;
  hash: string | null;
  bytes: number;
  text?: string;
}

type MonitorWatchResult =
  | ({
      target: 'process';
      id: string;
    } & Awaited<ReturnType<typeof watchBackgroundProcess>>)
  | {
      target: 'file';
      path: string;
      condition: FileWatchInput['condition'];
      matched: boolean;
      timedOut: boolean;
      exists: boolean;
      changed: boolean;
      contains: boolean;
      hash: string | null;
      bytes: number;
    };

function fsBackend(ctx: ToolContext) {
  return ctx.backends?.fs ?? createSandboxBackends(ctx.sandboxRoots, { defaultCwd: ctx.defaultCwd }).fs;
}

function isMissingFileError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') return true;
  return err instanceof Error && /ENOENT|no such file|not found/i.test(err.message);
}

async function contextWithReadAccess(path: string, ctx: ToolContext): Promise<ToolContext> {
  if (ctx.backends?.fs.delegated) return ctx;
  try {
    assertPathWithinRoots(path, ctx.sandboxRoots);
    return ctx;
  } catch (err) {
    const expanded = await gatePathAccess(path, ctx, err, {
      operation: 'read',
      pathKind: 'file',
      requestedByTool: 'monitor_watch'
    });
    return { ...ctx, sandboxRoots: expanded };
  }
}

async function readFileSnapshot(path: string, ctx: ToolContext): Promise<FileSnapshot> {
  const readCtx = await contextWithReadAccess(path, ctx);
  try {
    const text = await fsBackend(readCtx).readTextFile(path);
    return {
      exists: true,
      hash: sha256(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      text
    };
  } catch (err) {
    if (isMissingFileError(err)) return { exists: false, hash: null, bytes: 0 };
    throw err;
  }
}

/**
 * Cheap per-tick existence/mtime probe so the poll loop below doesn't read+hash the whole
 * file on every tick. Re-resolves and re-validates the path on every call (never caches a
 * "validated" verdict) so a symlink swapped in between ticks still gets caught — same
 * TOCTOU guarantee as readFileSnapshot, just without the full read.
 */
async function statFile(path: string, ctx: ToolContext): Promise<{ exists: boolean; statKey: string } | null> {
  if (ctx.backends?.fs.delegated) return null;
  const readCtx = await contextWithReadAccess(path, ctx);
  try {
    const real = await resolveReal(path, readCtx.sandboxRoots);
    const s = await stat(real);
    return { exists: true, statKey: `${s.mtimeMs}:${s.size}` };
  } catch (err) {
    if (isMissingFileError(err)) return { exists: false, statKey: 'missing' };
    throw err;
  }
}

function matchesText(text: string, pattern: string, match: 'literal' | 'regex' | undefined): boolean {
  if (match !== 'regex') return text.includes(pattern);
  try {
    return new RegExp(pattern).test(text);
  } catch (err) {
    throw new ToolSecurityError(`invalid monitor_watch regex: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function watchFile(
  input: FileWatchInput,
  ctx: ToolContext
): Promise<Extract<MonitorWatchResult, { target: 'file' }>> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  const initial =
    input.condition === 'changes' && input.baseHash === undefined ? await readFileSnapshot(input.path, ctx) : null;
  const baseHash = input.baseHash ?? initial?.hash ?? null;

  // `exists`/`changes`/`contains` all need a full read+hash the first time (or right after the
  // cheap stat below observes a real change) — cache that last full read so an unchanged file
  // doesn't pay readTextFile + sha256 over its whole content on every poll tick.
  let cachedStatKey: string | null = null;
  let cachedSnap: FileSnapshot | null = initial;
  if (cachedSnap) {
    const initialStat = await statFile(input.path, ctx);
    if (initialStat) cachedStatKey = initialStat.statKey;
  }

  for (;;) {
    if (ctx.signal?.aborted) throw new ToolSecurityError(`monitor_watch aborted for "${input.path}"`);

    const needsContent = input.condition === 'changes' || input.condition === 'contains';
    const probe = await statFile(input.path, ctx);

    let snap: FileSnapshot;
    if (!needsContent) {
      // `exists` only cares whether the path resolves — never reads file content.
      snap = probe ? { exists: probe.exists, hash: null, bytes: 0 } : await readFileSnapshot(input.path, ctx);
    } else if (probe?.exists && cachedSnap?.exists && probe.statKey === cachedStatKey) {
      // Cheap probe says nothing changed since the last full read — reuse it.
      snap = cachedSnap;
    } else {
      snap = await readFileSnapshot(input.path, ctx);
      cachedSnap = snap;
      cachedStatKey = probe?.statKey ?? null;
    }

    const contains = Boolean(input.pattern && snap.text && matchesText(snap.text, input.pattern, input.match));
    const changed = input.condition === 'changes' && snap.hash !== baseHash;
    const matched =
      (input.condition === 'exists' && snap.exists) || changed || (input.condition === 'contains' && contains);

    if (matched || Date.now() >= deadline) {
      return {
        target: 'file',
        path: input.path,
        condition: input.condition,
        matched,
        timedOut: !matched,
        exists: snap.exists,
        changed,
        contains,
        hash: snap.hash,
        bytes: snap.bytes
      };
    }

    await Bun.sleep(intervalMs);
  }
}

export const monitorWatchTool: Tool<MonitorWatchInput, MonitorWatchResult> = {
  name: 'monitor_watch',
  description:
    'Wait for external readiness without ad-hoc polling scripts. Use it for cross-resource waits such as process output/status plus file exists/changes/contains; use process_control.wait when you are actively controlling one background process.',
  scopes: [{ resource: 'shell:exec' }, { resource: 'fs:read' }],
  inputSchema: monitorWatchInput,
  run: async (input, ctx) => {
    if (input.target === 'process') {
      const result = await watchBackgroundProcess(input, ctx);
      return toolResult({ target: 'process', id: input.id, ...result });
    }
    return toolResult(await watchFile(input, ctx));
  }
};

const _register: ToolModule = () => [monitorWatchTool as Tool];
