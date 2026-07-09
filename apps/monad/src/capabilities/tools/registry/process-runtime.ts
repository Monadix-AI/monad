import type { ToolContext } from '../types.ts';

import { buildSandboxPolicy, sandboxedPtySpawn, sandboxedSpawn, ToolSecurityError } from '@monad/sandbox';

import { daemonChildProcesses } from '#/infra/daemon-child-processes.ts';
import { shellArgv, signalProcessTree } from '../backends.ts';

const MAX_BUFFER = 256 * 1024;
const ANSI_PATTERN_SOURCE =
  '[\\u001B\\u009B]' + '[[\\]()#;?]*' + '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?' + '[0-9A-ORZcf-nqry=><~]';
const ANSI_PATTERN = new RegExp(ANSI_PATTERN_SOURCE, 'g');

type Sub = ReturnType<typeof Bun.spawn>;

export type TerminalMode = 'pty' | 'pipe';
export type ProcessWriteKey =
  | 'enter'
  | 'tab'
  | 'escape'
  | 'backspace'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'up'
  | 'down'
  | 'left'
  | 'right';

export interface ProcessHandle {
  pid: number;
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  kill(): void;
  signal(signal: ProcessSignal): void;
  write(input: string): void;
  resize?(cols: number, rows: number): void;
}

export interface ProcEntry {
  id: string;
  ownerSessionId: string;
  command: string;
  cwd: string;
  mode: TerminalMode;
  proc: ProcessHandle;
  stdout: string;
  stderr: string;
  stdoutBase: number;
  stderrBase: number;
  stdoutCursor: number;
  stderrCursor: number;
  idleTimeoutMs?: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  maxRuntimeMs?: number;
  runtimeTimer?: ReturnType<typeof setTimeout>;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  startedAt: string;
  endedAt?: string;
  limits: { idleTimeoutMs?: number; maxRuntimeMs?: number };
}

export type ProcessSnapshot = {
  processId: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: string;
  limits: { idleTimeoutMs?: number; maxRuntimeMs?: number };
  status: ProcEntry['status'];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  mode: TerminalMode;
  cursor: { stdout: number; stderr: number };
  truncated: { stdout: boolean; stderr: boolean };
};

export type ProcessSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGKILL';

export interface ProcessSnapshotOptions {
  stripAnsi?: boolean;
}

export interface PtyStartOptions {
  cols?: number;
  rows?: number;
}

// Background shell_exec spawns detached, making the child a process-group leader; the cross-platform
// group-signalling glue lives in backends.ts (signalProcessTree).
function signalTree(proc: Sub, signal: ProcessSignal): void {
  signalProcessTree(proc, signal);
}

function killTree(proc: Sub): void {
  signalTree(proc, 'SIGTERM');
}

export function appendOutput(entry: ProcEntry, stream: 'stdout' | 'stderr', chunk: string): void {
  const textKey = stream;
  const baseKey = stream === 'stdout' ? 'stdoutBase' : 'stderrBase';
  const cursorKey = stream === 'stdout' ? 'stdoutCursor' : 'stderrCursor';
  entry[cursorKey] += chunk.length;
  const next = entry[textKey] + chunk;
  if (next.length > MAX_BUFFER) {
    entry[textKey] = next.slice(-MAX_BUFFER);
    entry[baseKey] = entry[cursorKey] - entry[textKey].length;
  } else {
    entry[textKey] = next;
  }
}

function clearIdleTimer(entry: ProcEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
}

function clearRuntimeTimer(entry: ProcEntry): void {
  if (entry.runtimeTimer) clearTimeout(entry.runtimeTimer);
  entry.runtimeTimer = undefined;
}

export function clearTimers(entry: ProcEntry): void {
  clearIdleTimer(entry);
  clearRuntimeTimer(entry);
}

export function resetIdleTimer(entry: ProcEntry): void {
  if (!entry.idleTimeoutMs || entry.status !== 'running') return;
  clearIdleTimer(entry);
  entry.idleTimer = setTimeout(() => {
    if (entry.status !== 'running') return;
    appendOutput(entry, 'stderr', `process killed after ${entry.idleTimeoutMs}ms idle timeout\n`);
    entry.proc.kill();
    entry.status = 'killed';
    entry.endedAt = new Date().toISOString();
    clearIdleTimer(entry);
  }, entry.idleTimeoutMs);
}

export function startRuntimeTimer(entry: ProcEntry): void {
  if (!entry.maxRuntimeMs || entry.status !== 'running') return;
  clearRuntimeTimer(entry);
  entry.runtimeTimer = setTimeout(() => {
    if (entry.status !== 'running') return;
    appendOutput(entry, 'stderr', `process killed after ${entry.maxRuntimeMs}ms max runtime\n`);
    entry.proc.kill();
    entry.status = 'killed';
    entry.endedAt = new Date().toISOString();
    clearTimers(entry);
  }, entry.maxRuntimeMs);
}

function sliceOutput(
  entry: ProcEntry,
  stream: 'stdout' | 'stderr',
  cursor?: number
): { text: string; truncated: boolean } {
  const text = entry[stream];
  const base = stream === 'stdout' ? entry.stdoutBase : entry.stderrBase;
  const end = stream === 'stdout' ? entry.stdoutCursor : entry.stderrCursor;
  const requested = cursor ?? 0;
  const start = Math.min(Math.max(requested, base), end);
  const truncated = requested < base;
  const sliced = text.slice(start - base);
  return { text: truncated ? `…[truncated]\n${sliced}` : sliced, truncated };
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function snapshot(
  entry: ProcEntry,
  cursor?: { stdout?: number; stderr?: number },
  options: ProcessSnapshotOptions = {}
): ProcessSnapshot {
  const stdout = sliceOutput(entry, 'stdout', cursor?.stdout);
  const stderr = sliceOutput(entry, 'stderr', cursor?.stderr);
  return {
    processId: entry.id,
    pid: entry.proc.pid,
    command: entry.command,
    cwd: entry.cwd,
    startedAt: entry.startedAt,
    limits: entry.limits,
    status: entry.status,
    exitCode: entry.exitCode,
    stdout: options.stripAnsi ? stripAnsi(stdout.text) : stdout.text,
    stderr: options.stripAnsi ? stripAnsi(stderr.text) : stderr.text,
    mode: entry.mode,
    cursor: { stdout: entry.stdoutCursor, stderr: entry.stderrCursor },
    truncated: { stdout: stdout.truncated, stderr: stderr.truncated }
  };
}

export function keySequence(key: ProcessWriteKey): string {
  switch (key) {
    case 'enter':
      return '\n';
    case 'tab':
      return '\t';
    case 'escape':
      return '\x1b';
    case 'backspace':
      return '\x7f';
    case 'ctrl-c':
      return '\x03';
    case 'ctrl-d':
      return '\x04';
    case 'up':
      return '\x1b[A';
    case 'down':
      return '\x1b[B';
    case 'right':
      return '\x1b[C';
    case 'left':
      return '\x1b[D';
  }
}

export async function drain(stream: ReadableStream<Uint8Array>, append: (chunk: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    append(decoder.decode(chunk, { stream: true }));
  }
}

export function attachExit(entry: ProcEntry): void {
  void entry.proc.exited.then((code) => {
    clearTimers(entry);
    if (entry.status === 'running') {
      entry.status = 'exited';
      entry.exitCode = code;
      entry.endedAt = new Date().toISOString();
    }
  });
}

function pipeHandle(proc: Sub): ProcessHandle {
  return {
    pid: proc.pid,
    exited: proc.exited,
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    kill: () => killTree(proc),
    signal: (signal) => signalTree(proc, signal),
    write(input) {
      const stdin = proc.stdin;
      if (!stdin || typeof stdin === 'number')
        throw new ToolSecurityError(`process "${proc.pid}" has no writable stdin`);
      stdin.write(input);
      stdin.flush();
    }
  };
}

export function startPipeProcess(command: string, dir: string, ctx: ToolContext): ProcessHandle {
  const proc = sandboxedSpawn(
    shellArgv(command),
    { cwd: dir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true },
    buildSandboxPolicy(ctx.sandboxRoots, [], ctx.sessionId),
    { sessionId: ctx.sessionId }
  );
  daemonChildProcesses.track(proc.pid, 'tool:shell_exec:background', () => killTree(proc));
  void proc.exited.then(() => daemonChildProcesses.untrack(proc.pid));
  return pipeHandle(proc);
}

export function startPtyProcess(
  command: string,
  dir: string,
  ctx: ToolContext,
  onData: (chunk: string) => void,
  options: PtyStartOptions = {}
): ProcessHandle {
  const decoder = new TextDecoder();
  let pendingCR = false;
  const proc = sandboxedPtySpawn(
    shellArgv(command),
    {
      cwd: dir,
      detached: true,
      terminal: {
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        data(_terminal, data) {
          let text = decoder.decode(data);
          if (pendingCR) text = `\r${text}`;
          pendingCR = text.endsWith('\r');
          if (pendingCR) text = text.slice(0, -1);
          text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          if (text) onData(text);
        }
      }
    },
    buildSandboxPolicy(ctx.sandboxRoots, [], ctx.sessionId),
    { sessionId: ctx.sessionId }
  );
  daemonChildProcesses.track(proc.pid, 'tool:shell_exec:background', () => killTree(proc));
  void proc.exited.then(() => daemonChildProcesses.untrack(proc.pid));
  if (!proc.terminal) throw new ToolSecurityError('failed to start pty terminal');
  void proc.exited.then(() => {
    if (pendingCR) onData('\n');
  });
  return {
    pid: proc.pid,
    exited: proc.exited,
    kill: () => {
      try {
        proc.terminal?.close();
      } catch {
        /* already gone */
      }
      killTree(proc);
    },
    signal: (signal) => signalTree(proc, signal),
    write(input) {
      const terminal = proc.terminal;
      if (!terminal) throw new ToolSecurityError(`process "${proc.pid}" has no writable terminal`);
      terminal.write(input);
    },
    resize(cols, rows) {
      const terminal = proc.terminal;
      if (!terminal) throw new ToolSecurityError(`process "${proc.pid}" has no resizable terminal`);
      terminal.resize(cols, rows);
    }
  };
}
