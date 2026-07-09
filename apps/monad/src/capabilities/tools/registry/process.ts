// Background process management for shell_exec mode:"background".
//
// shell_exec owns the high-risk approval boundary. This module owns process lifecycle state and
// secondary path gating for out-of-sandbox cwd access. All children are killed on daemon exit.

import type { Tool, ToolContext } from '../types.ts';

import { isAbsolute, resolve } from 'node:path';
import { createLogger } from '@monad/logger';
import { assertPathWithinRoots, ToolSecurityError } from '@monad/sandbox';
import { z } from 'zod';

import { gatePathAccess } from '../approval/path-gate.ts';
import { toolResult } from '../types.ts';
import {
  appendOutput,
  attachExit,
  clearTimers,
  drain,
  keySequence,
  type ProcEntry,
  type ProcessHandle,
  type ProcessSignal,
  type ProcessSnapshot,
  resetIdleTimer,
  snapshot,
  startPipeProcess,
  startPtyProcess,
  startRuntimeTimer,
  stripAnsi,
  type TerminalMode
} from './process-runtime.ts';

const log = createLogger('process');

const MAX_PROCESSES = 50; // per session — keeps one session from starving others
const MAX_PROCESSES_GLOBAL = 200; // per daemon — caps total fan-out across all sessions
const MAX_WAIT_MS = 600_000;
const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_RUNTIME_MS = 24 * 60 * 60 * 1000;
const MAX_WAIT_PATTERN = 2000;
const FINISHED_PROCESS_TTL_MS = 30 * 60 * 1000;

const registry = new Map<string, ProcEntry>();

type ProcessListResult = {
  processes: Array<{
    id: string;
    command: string;
    cwd: string;
    status: ProcEntry['status'];
    pid: number;
    startedAt: string;
    mode: TerminalMode;
    limits: { idleTimeoutMs?: number; maxRuntimeMs?: number };
  }>;
};

interface BackgroundProcessWatchInput {
  id: string;
  pattern?: string;
  match?: 'literal' | 'regex';
  stripAnsi?: boolean;
  timeoutMs?: number;
  status?: ProcEntry['status'];
  cursor?: { stdout?: number; stderr?: number };
}

type BackgroundProcessWatchResult = ProcessSnapshot & {
  matched: boolean;
  timedOut: boolean;
  reason: 'pattern' | 'status' | 'exit' | 'timeout';
};

process.on('exit', () => {
  for (const entry of registry.values()) entry.proc.kill();
});

// Owner mismatch returns the SAME error as a missing id: a session must not be able to
// probe the existence of another session's processes. The mismatch case is logged
// server-side (without leaking to the caller) so cross-session attempts leave an audit trail.
function getEntry(id: string, ctx: ToolContext): ProcEntry {
  // getEntry sits on the process_control.wait / monitor_watch poll loop (every 20ms) — an
  // unconditional O(registry.size) TTL sweep there is pure waste on every tick. Capacity-relevant
  // paths (startBackgroundProcess, listProcesses) still prune synchronously since they gate limits.
  pruneExpiredProcessesThrottled();
  const entry = registry.get(id);
  if (entry && entry.ownerSessionId !== ctx.sessionId) {
    ctx.log('warn', 'cross-session process access denied', {
      processId: id,
      owner: entry.ownerSessionId,
      requester: ctx.sessionId
    });
  }
  if (!entry || entry.ownerSessionId !== ctx.sessionId) throw new ToolSecurityError(`unknown process id "${id}"`);
  return entry;
}

const backgroundProcessInput = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  terminalMode: z.enum(['pty', 'pipe']).optional(),
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
  idleTimeoutMs: z.number().int().min(1).max(MAX_IDLE_TIMEOUT_MS).optional(),
  maxRuntimeMs: z.number().int().min(1).max(MAX_RUNTIME_MS).optional()
});

type BackgroundProcessInput = z.infer<typeof backgroundProcessInput>;
type BackgroundProcessResult = {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  mode: TerminalMode;
  startedAt: string;
  limits: { idleTimeoutMs?: number; maxRuntimeMs?: number };
};

export async function startBackgroundProcess(
  { command, cwd, terminalMode, cols, rows, idleTimeoutMs, maxRuntimeMs }: BackgroundProcessInput,
  ctx: ToolContext
): Promise<BackgroundProcessResult> {
  pruneExpiredProcesses(ctx.sessionId);

  // Two ceilings: per-session (no starvation) and per-daemon (no total fan-out exhaustion).
  let ownedRunning = 0;
  for (const e of registry.values()) if (e.ownerSessionId === ctx.sessionId) ownedRunning++;
  if (ownedRunning >= MAX_PROCESSES) {
    throw new ToolSecurityError(`too many background processes (>= ${MAX_PROCESSES}); kill some first`);
  }
  if (registry.size >= MAX_PROCESSES_GLOBAL) {
    throw new ToolSecurityError(`daemon background-process limit reached (>= ${MAX_PROCESSES_GLOBAL})`);
  }

  const requestedCwd = cwd ?? ctx.sandboxRoots?.[0] ?? process.cwd();
  const absCwd = isAbsolute(requestedCwd)
    ? resolve(requestedCwd)
    : resolve(ctx.sandboxRoots?.[0] ?? process.cwd(), requestedCwd);
  let runCtx = ctx;
  let dir: string;
  try {
    dir = assertPathWithinRoots(absCwd, ctx.sandboxRoots);
  } catch (err) {
    const expandedRoots = await gatePathAccess(absCwd, ctx, err, {
      dir: absCwd,
      operation: 'cwd',
      pathKind: 'directory',
      requestedByTool: 'shell_exec'
    });
    runCtx = { ...ctx, sandboxRoots: expandedRoots };
    dir = assertPathWithinRoots(absCwd, expandedRoots);
  }
  let mode = terminalMode ?? 'pty';
  const stdoutChunks: string[] = [];
  let entry: ProcEntry | undefined;
  const startPty = (): ProcessHandle =>
    startPtyProcess(
      command,
      dir,
      runCtx,
      (chunk) => {
        if (entry) {
          appendOutput(entry, 'stdout', chunk);
          resetIdleTimer(entry);
        } else {
          stdoutChunks.push(chunk);
        }
      },
      { cols, rows }
    );
  let started: ProcessHandle;
  if (mode === 'pty') {
    try {
      started = startPty();
    } catch (err) {
      // PTY allocation can fail where ConPTY isn't available (older Windows) or a launcher can't
      // attach a terminal. Degrade to pipe mode so the command still runs.
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'pty terminal unavailable — falling back to pipe mode'
      );
      mode = 'pipe';
      started = startPipeProcess(command, dir, runCtx);
    }
  } else {
    started = startPipeProcess(command, dir, runCtx);
  }
  const id = `proc_${crypto.randomUUID()}`;
  entry = {
    id,
    ownerSessionId: ctx.sessionId,
    command,
    cwd: dir,
    mode,
    proc: started,
    stdout: '',
    stderr: '',
    stdoutBase: 0,
    stderrBase: 0,
    stdoutCursor: 0,
    stderrCursor: 0,
    idleTimeoutMs,
    maxRuntimeMs,
    status: 'running',
    exitCode: null,
    startedAt: new Date().toISOString(),
    limits: {
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      ...(maxRuntimeMs !== undefined ? { maxRuntimeMs } : {})
    }
  };
  registry.set(id, entry);

  if (mode === 'pty') {
    for (const chunk of stdoutChunks.splice(0)) appendOutput(entry, 'stdout', chunk);
  } else {
    void drain(started.stdout as ReadableStream<Uint8Array>, (c) => {
      appendOutput(entry, 'stdout', c);
      resetIdleTimer(entry);
    });
    void drain(started.stderr as ReadableStream<Uint8Array>, (c) => {
      appendOutput(entry, 'stderr', c);
      resetIdleTimer(entry);
    });
  }
  resetIdleTimer(entry);
  startRuntimeTimer(entry);
  attachExit(entry);

  return {
    id,
    pid: entry.proc.pid,
    command: entry.command,
    cwd: entry.cwd,
    mode,
    startedAt: entry.startedAt,
    limits: entry.limits
  };
}

const processCursorInput = z
  .object({
    stdout: z.number().int().min(0).optional(),
    stderr: z.number().int().min(0).optional()
  })
  .optional();

/** Kill and drop every background process owned by a session (session end/reset). */
export function clearProcessesForSession(sessionId: string): void {
  for (const [id, e] of registry) {
    if (e.ownerSessionId !== sessionId) continue;
    clearTimers(e);
    e.proc.kill();
    registry.delete(id);
  }
}

/** Test/maintenance helper: kill all and clear the registry. */
export function clearProcesses(): void {
  for (const e of registry.values()) {
    clearTimers(e);
    e.proc.kill();
  }
  registry.clear();
}

function pruneExpiredProcesses(sessionId: string | undefined, now = Date.now()): void {
  for (const [id, e] of registry) {
    if (sessionId !== undefined && e.ownerSessionId !== sessionId) continue;
    if (e.status === 'running' || e.endedAt === undefined) continue;
    if (now - Date.parse(e.endedAt) >= FINISHED_PROCESS_TTL_MS) registry.delete(id);
  }
}

const PRUNE_INTERVAL_MS = 2_000;
let lastPruneAt = 0;

// Deletions are idempotent and TTL-expiry is not time-critical, so a bounded staleness window is
// safe: a hot-path reader may see an expired entry linger up to PRUNE_INTERVAL_MS past its TTL.
function pruneExpiredProcessesThrottled(now = Date.now()): void {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  pruneExpiredProcesses(undefined, now);
}

export function expireFinishedProcessesForTests(ageMs = FINISHED_PROCESS_TTL_MS + 1): void {
  const endedAt = new Date(Date.now() - ageMs).toISOString();
  for (const e of registry.values()) {
    if (e.status !== 'running') e.endedAt = endedAt;
  }
  pruneExpiredProcesses(undefined);
}

const processControlInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('logs'),
    id: z.string().min(1),
    cursor: processCursorInput,
    stripAnsi: z.boolean().optional()
  }),
  z.object({
    action: z.literal('wait'),
    id: z.string().min(1),
    pattern: z.string().min(1).max(MAX_WAIT_PATTERN).optional(),
    match: z.enum(['literal', 'regex']).optional(),
    stripAnsi: z.boolean().optional(),
    timeoutMs: z.number().int().min(1).max(MAX_WAIT_MS).optional(),
    cursor: processCursorInput
  }),
  z
    .object({
      action: z.literal('write'),
      id: z.string().min(1),
      input: z.string().optional(),
      key: z.enum(['enter', 'tab', 'escape', 'backspace', 'ctrl-c', 'ctrl-d', 'up', 'down', 'left', 'right']).optional()
    })
    .refine((value) => value.input !== undefined || value.key !== undefined, {
      message: 'input or key is required'
    }),
  z.object({
    action: z.literal('resize'),
    id: z.string().min(1),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000)
  }),
  z.object({
    action: z.literal('signal'),
    id: z.string().min(1),
    signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL'])
  }),
  z.object({ action: z.literal('stop'), id: z.string().min(1) }),
  z.object({
    action: z.literal('list'),
    status: z.enum(['running', 'exited', 'killed']).optional()
  })
]);

type ProcessControlInput = z.infer<typeof processControlInput>;
type ProcessControlResult =
  | ProcessSnapshot
  | (ProcessSnapshot & { matched: boolean; timedOut: boolean })
  | { ok: true }
  | ProcessListResult;

function listProcesses(ctx: ToolContext, status?: ProcEntry['status']): ProcessListResult {
  pruneExpiredProcesses(ctx.sessionId);
  return {
    processes: Array.from(registry.values())
      .filter((e) => e.ownerSessionId === ctx.sessionId)
      .filter((e) => status === undefined || e.status === status)
      .map((e) => ({
        id: e.id,
        command: e.command,
        cwd: e.cwd,
        status: e.status,
        pid: e.proc.pid,
        startedAt: e.startedAt,
        mode: e.mode,
        limits: e.limits
      }))
  };
}

function stopProcess(id: string, ctx: ToolContext): void {
  const e = getEntry(id, ctx);
  if (e.status !== 'running') return;
  e.proc.kill();
  e.status = 'killed';
  e.endedAt = new Date().toISOString();
  clearTimers(e);
}

async function waitForProcess(
  {
    id,
    pattern,
    match,
    stripAnsi: shouldStripAnsi,
    timeoutMs,
    cursor
  }: Extract<ProcessControlInput, { action: 'wait' }>,
  ctx: ToolContext
): Promise<ProcessSnapshot & { matched: boolean; timedOut: boolean }> {
  const result = await watchBackgroundProcess(
    { id, pattern, match, stripAnsi: shouldStripAnsi, timeoutMs, cursor },
    ctx
  );
  return {
    ...result,
    matched: result.matched,
    timedOut: result.timedOut
  };
}

export async function watchBackgroundProcess(
  { id, pattern, match, stripAnsi: shouldStripAnsi, timeoutMs, status, cursor }: BackgroundProcessWatchInput,
  ctx: ToolContext
): Promise<BackgroundProcessWatchResult> {
  const deadline = Date.now() + (timeoutMs ?? 30_000);
  let regex: RegExp | undefined;
  if (pattern && match === 'regex') {
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      throw new ToolSecurityError(
        `invalid process_control wait regex: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  for (;;) {
    if (ctx.signal?.aborted) throw new ToolSecurityError(`process watch aborted for "${id}"`);
    const e = getEntry(id, ctx);
    const stdout = shouldStripAnsi ? stripAnsi(e.stdout) : e.stdout;
    const stderr = shouldStripAnsi ? stripAnsi(e.stderr) : e.stderr;
    const patternMatched = pattern
      ? regex
        ? regex.test(stdout) || regex.test(stderr)
        : stdout.includes(pattern) || stderr.includes(pattern)
      : false;
    if (patternMatched)
      return {
        ...snapshot(e, cursor, { stripAnsi: shouldStripAnsi }),
        matched: true,
        timedOut: false,
        reason: 'pattern'
      };
    if (status && e.status === status)
      return {
        ...snapshot(e, cursor, { stripAnsi: shouldStripAnsi }),
        matched: true,
        timedOut: false,
        reason: 'status'
      };
    if (!pattern && !status && e.status !== 'running')
      return {
        ...snapshot(e, cursor, { stripAnsi: shouldStripAnsi }),
        matched: true,
        timedOut: false,
        reason: 'exit'
      };
    if (e.status !== 'running')
      return {
        ...snapshot(e, cursor, { stripAnsi: shouldStripAnsi }),
        matched: false,
        timedOut: false,
        reason: status ? 'status' : 'exit'
      };
    if (Date.now() >= deadline)
      return {
        ...snapshot(e, cursor, { stripAnsi: shouldStripAnsi }),
        matched: false,
        timedOut: true,
        reason: 'timeout'
      };
    await Bun.sleep(20);
  }
}

export const processControlTool: Tool<ProcessControlInput, ProcessControlResult> = {
  name: 'process_control',
  description:
    'Manage background processes created by shell_exec mode:"background": read logs, wait for output or exit, write input, resize, signal, stop, or list. Use process_control.wait for one process you are actively controlling; use monitor_watch for cross-resource waits such as file readiness.',
  scopes: [{ resource: 'shell:exec' }],
  inputSchema: processControlInput,
  run: async (input, ctx) => {
    switch (input.action) {
      case 'logs':
        return toolResult(snapshot(getEntry(input.id, ctx), input.cursor, { stripAnsi: input.stripAnsi }));
      case 'wait':
        return toolResult(await waitForProcess(input, ctx));
      case 'write': {
        const e = getEntry(input.id, ctx);
        if (e.status !== 'running') throw new ToolSecurityError(`process "${input.id}" is not running (${e.status})`);
        if (input.input !== undefined) e.proc.write(input.input);
        if (input.key) e.proc.write(keySequence(input.key));
        resetIdleTimer(e);
        return toolResult({ ok: true as const });
      }
      case 'resize': {
        const e = getEntry(input.id, ctx);
        if (e.status !== 'running') throw new ToolSecurityError(`process "${input.id}" is not running (${e.status})`);
        if (e.mode !== 'pty' || !e.proc.resize) throw new ToolSecurityError(`process "${input.id}" is not pty-backed`);
        e.proc.resize(input.cols, input.rows);
        return toolResult({ ok: true as const });
      }
      case 'signal': {
        const e = getEntry(input.id, ctx);
        if (e.status !== 'running') throw new ToolSecurityError(`process "${input.id}" is not running (${e.status})`);
        e.proc.signal(input.signal as ProcessSignal);
        resetIdleTimer(e);
        return toolResult({ ok: true as const });
      }
      case 'stop':
        stopProcess(input.id, ctx);
        return toolResult({ ok: true as const });
      case 'list':
        return toolResult(listProcesses(ctx, input.status));
    }
  }
};

const processTools: Tool[] = [processControlTool as Tool];

import type { ToolModule } from './contract.ts';
// Uniform module entry. Static module — no boot deps.
export const register: ToolModule = () => processTools;
