// Background process management — unlike shell_exec (blocking + timeout), these start
// long-lived commands and manage them across tool calls.
//
// process_start is HIGH-RISK (arbitrary command) → human-approved. The rest manage an
// already-approved process and are not gated. All children are killed on daemon exit.

import type { Tool, ToolContext } from '../types.ts';

import { createLogger } from '@monad/logger';
import { z } from 'zod';

import { assertPathWithinRoots, ToolSecurityError } from '../security.ts';
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

const registry = new Map<string, ProcEntry>();

process.on('exit', () => {
  for (const entry of registry.values()) entry.proc.kill();
});

// Owner mismatch returns the SAME error as a missing id: a session must not be able to
// probe the existence of another session's processes. The mismatch case is logged
// server-side (without leaking to the caller) so cross-session attempts leave an audit trail.
function getEntry(id: string, ctx: ToolContext): ProcEntry {
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

const processStartInput = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  terminalMode: z.enum(['pty', 'pipe']).optional(),
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
  idleTimeoutMs: z.number().int().min(1).max(MAX_IDLE_TIMEOUT_MS).optional(),
  maxRuntimeMs: z.number().int().min(1).max(MAX_RUNTIME_MS).optional()
});

export const processStartTool: Tool<
  z.infer<typeof processStartInput>,
  { id: string; pid: number; mode: TerminalMode }
> = {
  name: 'process_start',
  description:
    'Start a long-running command in the background and return a process id to poll/write/kill. Defaults to an interactive PTY terminal that can be driven with process_write; pass terminalMode:"pipe" for plain stdin/stdout pipes.',
  scopes: [{ resource: 'shell:exec' }],
  highRisk: true,
  inputSchema: processStartInput,
  run: async ({ command, cwd, terminalMode, cols, rows, idleTimeoutMs, maxRuntimeMs }, ctx) => {
    // Prune this session's finished entries so completed runs don't consume capacity.
    for (const e of registry.values())
      if (e.ownerSessionId === ctx.sessionId && e.status !== 'running') registry.delete(e.id);

    // Two ceilings: per-session (no starvation) and per-daemon (no total fan-out exhaustion).
    let ownedRunning = 0;
    for (const e of registry.values()) if (e.ownerSessionId === ctx.sessionId) ownedRunning++;
    if (ownedRunning >= MAX_PROCESSES) {
      throw new ToolSecurityError(`too many background processes (>= ${MAX_PROCESSES}); kill some first`);
    }
    if (registry.size >= MAX_PROCESSES_GLOBAL) {
      throw new ToolSecurityError(`daemon background-process limit reached (>= ${MAX_PROCESSES_GLOBAL})`);
    }

    const dir = assertPathWithinRoots(cwd ?? ctx.sandboxRoots?.[0] ?? process.cwd(), ctx.sandboxRoots);
    let mode = terminalMode ?? 'pty';
    const stdoutChunks: string[] = [];
    let entry: ProcEntry | undefined;
    const startPty = (): ProcessHandle =>
      startPtyProcess(
        command,
        dir,
        ctx,
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
        // attach a terminal. Degrade to pipe mode instead of hard-failing process_start; the caller
        // loses interactive echo/resize but the command still runs.
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'pty terminal unavailable — falling back to pipe mode'
        );
        mode = 'pipe';
        started = startPipeProcess(command, dir, ctx);
      }
    } else {
      started = startPipeProcess(command, dir, ctx);
    }
    const id = `proc_${crypto.randomUUID()}`;
    entry = {
      id,
      ownerSessionId: ctx.sessionId,
      command,
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
      startedAt: new Date().toISOString()
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

    return toolResult({ id, pid: entry.proc.pid, mode });
  }
};

const processCursorInput = z
  .object({
    stdout: z.number().int().min(0).optional(),
    stderr: z.number().int().min(0).optional()
  })
  .optional();

const processLogsInput = z.object({
  id: z.string().min(1),
  cursor: processCursorInput,
  stripAnsi: z.boolean().optional()
});

export const processLogsTool: Tool<z.infer<typeof processLogsInput>, ProcessSnapshot> = {
  name: 'process_logs',
  description:
    'Read output and status of a background process. Pass the returned cursor to read only new output. PTY output is a normalized terminal transcript: CRLF/CR become LF, while ANSI sequences and input echo may remain.',
  scopes: [{ resource: 'shell:exec' }],
  inputSchema: processLogsInput,
  run: async ({ id, cursor, stripAnsi }, ctx) => {
    const e = getEntry(id, ctx);
    return toolResult(snapshot(e, cursor, { stripAnsi }));
  }
};

const processWaitInput = z.object({
  id: z.string().min(1),
  pattern: z.string().min(1).max(MAX_WAIT_PATTERN).optional(),
  match: z.enum(['literal', 'regex']).optional(),
  stripAnsi: z.boolean().optional(),
  timeoutMs: z.number().int().min(1).max(MAX_WAIT_MS).optional()
});

export const processWaitTool: Tool<
  z.infer<typeof processWaitInput>,
  ProcessSnapshot & { matched: boolean; timedOut: boolean }
> = {
  name: 'process_wait',
  description:
    'Wait until a background process exits or until stdout/stderr matches a literal or regex pattern. Returns the current logs and whether the wait matched or timed out.',
  scopes: [{ resource: 'shell:exec' }],
  inputSchema: processWaitInput,
  run: async ({ id, pattern, match, stripAnsi: shouldStripAnsi, timeoutMs }, ctx) => {
    const deadline = Date.now() + (timeoutMs ?? 30_000);
    let regex: RegExp | undefined;
    if (pattern && match === 'regex') {
      try {
        regex = new RegExp(pattern);
      } catch (err) {
        throw new ToolSecurityError(`invalid process_wait regex: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (;;) {
      if (ctx.signal?.aborted) throw new ToolSecurityError(`process_wait aborted for "${id}"`);
      const e = getEntry(id, ctx);
      const stdout = shouldStripAnsi ? stripAnsi(e.stdout) : e.stdout;
      const stderr = shouldStripAnsi ? stripAnsi(e.stderr) : e.stderr;
      const matched = pattern
        ? regex
          ? regex.test(stdout) || regex.test(stderr)
          : stdout.includes(pattern) || stderr.includes(pattern)
        : e.status !== 'running';
      if (matched)
        return toolResult({
          ...snapshot(e, undefined, { stripAnsi: shouldStripAnsi }),
          matched: true,
          timedOut: false
        });
      if (e.status !== 'running')
        return toolResult({
          ...snapshot(e, undefined, { stripAnsi: shouldStripAnsi }),
          matched: false,
          timedOut: false
        });
      if (Date.now() >= deadline)
        return toolResult({
          ...snapshot(e, undefined, { stripAnsi: shouldStripAnsi }),
          matched: false,
          timedOut: true
        });
      await Bun.sleep(20);
    }
  }
};

const processWriteInput = z
  .object({
    id: z.string().min(1),
    input: z.string().optional(),
    key: z.enum(['enter', 'tab', 'escape', 'backspace', 'ctrl-c', 'ctrl-d', 'up', 'down', 'left', 'right']).optional()
  })
  .refine((value) => value.input !== undefined || value.key !== undefined, {
    message: 'input or key is required'
  });

export const processWriteTool: Tool<z.infer<typeof processWriteInput>, { ok: true }> = {
  name: 'process_write',
  description:
    "Write to a background process's stdin or PTY (e.g. answer a prompt). Pass input for text and/or key for enter, escape, ctrl-c, ctrl-d, tab, backspace, or arrow keys.",
  scopes: [{ resource: 'shell:exec' }],
  inputSchema: processWriteInput,
  run: async ({ id, input, key }, ctx) => {
    const e = getEntry(id, ctx);
    if (e.status !== 'running') throw new ToolSecurityError(`process "${id}" is not running (${e.status})`);
    if (input !== undefined) e.proc.write(input);
    if (key) e.proc.write(keySequence(key));
    resetIdleTimer(e);
    return toolResult({ ok: true });
  }
};

const processResizeInput = z.object({
  id: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000)
});

export const processResizeTool: Tool<z.infer<typeof processResizeInput>, { ok: true }> = {
  name: 'process_resize',
  description: 'Resize a PTY-backed background process. Use this before running or driving full-screen terminal UI.',
  scopes: [{ resource: 'shell:exec' }],
  inputSchema: processResizeInput,
  run: async ({ id, cols, rows }, ctx) => {
    const e = getEntry(id, ctx);
    if (e.status !== 'running') throw new ToolSecurityError(`process "${id}" is not running (${e.status})`);
    if (e.mode !== 'pty' || !e.proc.resize) throw new ToolSecurityError(`process "${id}" is not pty-backed`);
    e.proc.resize(cols, rows);
    return toolResult({ ok: true });
  }
};

const processSignalInput = z.object({
  id: z.string().min(1),
  signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL'])
});

export const processSignalTool: Tool<z.infer<typeof processSignalInput>, { ok: true }> = {
  name: 'process_signal',
  description: 'Send a POSIX-style signal to a background process group, such as SIGINT or SIGTERM.',
  scopes: [{ resource: 'shell:exec' }],
  inputSchema: processSignalInput,
  run: async ({ id, signal }, ctx) => {
    const e = getEntry(id, ctx);
    if (e.status !== 'running') throw new ToolSecurityError(`process "${id}" is not running (${e.status})`);
    e.proc.signal(signal as ProcessSignal);
    resetIdleTimer(e);
    return toolResult({ ok: true });
  }
};

export const processListTool: Tool<
  Record<string, never>,
  {
    processes: Array<{
      id: string;
      command: string;
      status: ProcEntry['status'];
      pid: number;
      startedAt: string;
      mode: TerminalMode;
    }>;
  }
> = {
  name: 'process_list',
  description: 'List background processes with their id, command, and status.',
  scopes: [{ resource: 'shell:exec' }],
  inputSchema: z.object({}),
  run: async (_input, ctx) =>
    toolResult({
      processes: Array.from(registry.values())
        .filter((e) => e.ownerSessionId === ctx.sessionId)
        .map((e) => ({
          id: e.id,
          command: e.command,
          status: e.status,
          pid: e.proc.pid,
          startedAt: e.startedAt,
          mode: e.mode
        }))
    })
};

const processKillInput = z.object({ id: z.string().min(1) });

export const processKillTool: Tool<z.infer<typeof processKillInput>, { ok: boolean }> = {
  name: 'process_kill',
  description: 'Terminate a background process. Its final logs stay readable via process_logs until pruned.',
  scopes: [{ resource: 'shell:exec' }],
  inputSchema: processKillInput,
  run: async ({ id }, ctx) => {
    const e = getEntry(id, ctx);
    if (e.status === 'running') {
      e.proc.kill();
      e.status = 'killed';
      clearTimers(e);
    }
    return toolResult({ ok: true });
  }
};

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

const processTools: Tool[] = [
  processStartTool as Tool,
  processLogsTool as Tool,
  processWaitTool as Tool,
  processWriteTool as Tool,
  processResizeTool as Tool,
  processSignalTool as Tool,
  processListTool as Tool,
  processKillTool as Tool
];

import type { ToolModule } from './contract.ts';
// Uniform module entry. Static module — no boot deps.
export const register: ToolModule = () => processTools;
