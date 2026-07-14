// The exec channel: run argv inside the guest over vsock (a direct host↔guest transport, independent
// of the guest NIC). vfkit bridges a host unix socket to the guest's vsock port where monad-vsock-agent
// listens; we speak a small framed protocol over it. Unlike ssh this needs no sshd, no key, and no
// guest NIC — so net:'none' can drop the network device entirely.
//
// Wire protocol (big-endian), matching this package's native/vsock-agent/main.go:
//   request  (host→guest): [len:u32][json]   json = {argv, cwd, env}
//   response (guest→host): [channel:u8][len:u32][data]   channel 1=stdout 2=stderr 3=exit(u32 code)

import type {
  SandboxExit,
  SandboxProcess,
  SandboxRunLimits,
  SandboxStdin,
  SandboxTerminal,
  SandboxTerminalOptions,
  SandboxViolation
} from '@monad/sdk-atom';

import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';

import {
  encodeFrame,
  type FilesystemObservationPolicy,
  FrameDecoder,
  GuestFrameKind,
  HostFrameKind,
  MAX_STREAM_FRAME_BYTES,
  normalizeSignal,
  VSOCK_PROTOCOL_VERSION
} from './protocol.ts';

export interface VsockExecSpec {
  /** The host endpoint bridging to the guest's vsock exec port: a unix socket (vfkit exposes it
   *  directly on macOS; socat bridges it on Linux) or a named pipe `\\.\pipe\…` (winvm-helper
   *  bridges hvsock on Windows — node's connect(path) dials pipes there natively). */
  socketPath: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  runId?: string;
  limits?: SandboxRunLimits;
  terminal?: SandboxTerminalOptions;
  observation?: FilesystemObservationPolicy;
  onUnresponsive?: (error: Error) => void;
}

interface StartedMessage {
  runId: string;
  pid: number;
}

export interface BaselineReadyMessage {
  bootEpoch: string;
  agentDigest: string;
  activeRuns: number;
  everStarted: boolean;
  captureEligible: boolean;
}

export async function prepareVmBaseline(
  socketPath: string,
  agentDigest: string,
  timeoutMs = 5000
): Promise<BaselineReadyMessage> {
  return baselineHandshake(socketPath, HostFrameKind.PrepareBaseline, { agentDigest }, timeoutMs);
}

export async function confirmRestoredVmBaseline(
  socketPath: string,
  bootEpoch: string,
  agentDigest: string,
  timeoutMs = 5000
): Promise<BaselineReadyMessage> {
  return baselineHandshake(socketPath, HostFrameKind.RestoredBaseline, { bootEpoch, agentDigest }, timeoutMs);
}

function baselineHandshake(
  socketPath: string,
  kind: HostFrameKind.PrepareBaseline | HostFrameKind.RestoredBaseline,
  request: { bootEpoch?: string; agentDigest: string },
  timeoutMs: number
): Promise<BaselineReadyMessage> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('vsock baseline handshake timed out'));
    }, timeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once('connect', () => {
      socket.write(encodeFrame(kind, jsonPayload({ version: VSOCK_PROTOCOL_VERSION, ...request })));
    });
    socket.on('data', (chunk) => {
      try {
        for (const frame of decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)) {
          if (frame.kind === GuestFrameKind.Error) {
            const value = parseJson(frame.payload, 'baseline error') as { message?: unknown };
            fail(new Error(typeof value.message === 'string' ? value.message : 'guest rejected baseline'));
            return;
          }
          if (frame.kind !== GuestFrameKind.BaselineReady) throw new Error('vsock protocol: invalid baseline frame');
          const value = parseJson(frame.payload, 'baseline ready') as Partial<BaselineReadyMessage>;
          if (
            typeof value.bootEpoch !== 'string' ||
            value.bootEpoch.length === 0 ||
            value.agentDigest !== request.agentDigest ||
            value.activeRuns !== 0 ||
            value.everStarted !== false ||
            value.captureEligible !== true
          ) {
            throw new Error('vsock protocol: invalid baseline ready payload');
          }
          clearTimeout(timer);
          socket.end();
          resolve(value as BaselineReadyMessage);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('error', (error) => fail(new Error(`vsock baseline transport failed: ${error.message}`)));
    socket.once('close', () => clearTimeout(timer));
  });
}

function jsonPayload(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function parseJson(payload: Buffer, label: string): unknown {
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    throw new Error(`vsock protocol: invalid ${label} payload`);
  }
}

function parseStarted(payload: Buffer, runId: string): StartedMessage {
  const value = parseJson(payload, 'started') as Partial<StartedMessage>;
  if (value.runId !== runId || !Number.isInteger(value.pid) || (value.pid ?? 0) < 1) {
    throw new Error('vsock protocol: invalid started payload');
  }
  return value as StartedMessage;
}

function parseExit(payload: Buffer): SandboxExit {
  const value = parseJson(payload, 'exit') as Partial<SandboxExit>;
  const validCode = value.code === null || (Number.isInteger(value.code) && (value.code ?? -1) >= 0);
  const validSignal = value.signal === null || (Number.isInteger(value.signal) && (value.signal ?? -1) >= 0);
  if (!validCode || !validSignal || (value.code === null && !value.signal)) {
    throw new Error('vsock protocol: invalid exit payload');
  }
  return { code: value.code as number | null, signal: value.signal as number | null };
}

const VIOLATION_KINDS = new Set<SandboxViolation['kind']>([
  'protocol',
  'setup',
  'memory',
  'process-limit',
  'runtime',
  'filesystem'
]);
const VIOLATION_OPERATIONS = new Set([
  'oom',
  'oom-kill',
  'pids-max',
  'namespace-init',
  'cgroup-init',
  'pty-init',
  'mount-init',
  'runtime-exit',
  'unsupported-operation',
  'violation-limit',
  'seccomp-observer',
  'open',
  'openat',
  'openat2',
  'creat',
  'truncate',
  'ftruncate',
  'unlink',
  'unlinkat',
  'mkdir',
  'mkdirat',
  'rmdir',
  'mknod',
  'mknodat',
  'rename',
  'renameat',
  'renameat2',
  'link',
  'linkat',
  'symlink',
  'symlinkat'
]);
const MAX_VIOLATION_TEXT_BYTES = 4096;

function boundedText(value: unknown, required: boolean): value is string {
  return (
    (value !== undefined || required) &&
    typeof value === 'string' &&
    (!required || value.length > 0) &&
    Buffer.byteLength(value, 'utf8') <= MAX_VIOLATION_TEXT_BYTES
  );
}

function parseViolation(payload: Buffer, runId: string): SandboxViolation {
  const value = parseJson(payload, 'violation') as Partial<Omit<SandboxViolation, 'timestamp'>>;
  if (
    !VIOLATION_KINDS.has(value.kind as SandboxViolation['kind']) ||
    !boundedText(value.operation, true) ||
    !VIOLATION_OPERATIONS.has(value.operation) ||
    value.runId !== runId ||
    (value.target !== undefined && !boundedText(value.target, false)) ||
    (value.detail !== undefined && !boundedText(value.detail, false)) ||
    (value.pid !== undefined && (!Number.isInteger(value.pid) || value.pid < 1))
  ) {
    throw new Error('vsock protocol: invalid violation payload');
  }
  return {
    kind: value.kind as SandboxViolation['kind'],
    operation: value.operation,
    runId,
    timestamp: new Date().toISOString(),
    ...(value.target === undefined ? {} : { target: value.target }),
    ...(value.pid === undefined ? {} : { pid: value.pid }),
    ...(value.detail === undefined ? {} : { detail: value.detail })
  };
}

function terminalSize(cols: number, rows: number): SandboxTerminalOptions {
  if (![cols, rows].every((value) => Number.isInteger(value) && value >= 1 && value <= 1000)) {
    throw new Error('vsock protocol: terminal dimensions must be integers from 1 through 1000');
  }
  return { cols, rows };
}

function exitCodeOf(exit: SandboxExit): number {
  return exit.code ?? 128 + (exit.signal ?? 0);
}

export function vsockExec(argv: string[], spec: VsockExecSpec): SandboxProcess {
  const terminalOptions = spec.terminal ? terminalSize(spec.terminal.cols, spec.terminal.rows) : undefined;
  const runId = spec.runId ?? randomUUID();
  const env = Object.fromEntries(
    Object.entries(spec.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const sock = connect(spec.socketPath);
  const decoder = new FrameDecoder();
  const stdout = new TransformStream<Uint8Array, Uint8Array>();
  const stderr = new TransformStream<Uint8Array, Uint8Array>();
  const violations = new TransformStream<SandboxViolation, SandboxViolation>();
  const stdoutWriter = stdout.writable.getWriter();
  const stderrWriter = stderr.writable.getWriter();
  const violationWriter = violations.writable.getWriter();
  let pid: number | undefined;
  let exitCode: number | null = null;
  let settled = false;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  let terminalClosed = false;
  let connected = false;
  const pendingFrames: Buffer[] = [];

  let resolveExit!: (value: SandboxExit) => void;
  let rejectExit!: (reason: Error) => void;
  const exit = new Promise<SandboxExit>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const exited = exit.then(exitCodeOf);

  const closeStreams = () => {
    void stdoutWriter.close().catch(() => {});
    void stderrWriter.close().catch(() => {});
    void violationWriter.close().catch(() => {});
  };
  const fail = (error: Error, notify = true) => {
    if (settled) return;
    settled = true;
    if (terminationTimer) clearTimeout(terminationTimer);
    closeStreams();
    rejectExit(error);
    if (notify) spec.onUnresponsive?.(error);
    sock.destroy();
  };
  const complete = (result: SandboxExit) => {
    if (settled) return;
    settled = true;
    if (terminationTimer) clearTimeout(terminationTimer);
    exitCode = exitCodeOf(result);
    closeStreams();
    resolveExit(result);
    sock.end();
  };
  const send = (kind: HostFrameKind, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) => {
    if (settled) throw new Error('vsock process has exited');
    const frame = encodeFrame(kind, payload);
    if (connected) sock.write(frame);
    else pendingFrames.push(frame);
  };

  sock.once('connect', () => {
    connected = true;
    for (const frame of pendingFrames.splice(0)) sock.write(frame);
  });

  send(
    HostFrameKind.Start,
    jsonPayload({
      version: VSOCK_PROTOCOL_VERSION,
      runId,
      argv,
      cwd: spec.cwd,
      env,
      limits: spec.limits ?? {},
      ...(terminalOptions ? { terminal: terminalOptions } : {}),
      ...(spec.observation ? { observation: spec.observation } : {})
    })
  );

  sock.on('data', (chunk: Buffer) => {
    try {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind === GuestFrameKind.Started) pid = parseStarted(frame.payload, runId).pid;
        else if (frame.kind === GuestFrameKind.Stdout) void stdoutWriter.write(new Uint8Array(frame.payload));
        else if (frame.kind === GuestFrameKind.Stderr) void stderrWriter.write(new Uint8Array(frame.payload));
        else if (frame.kind === GuestFrameKind.Violation) {
          void violationWriter.write(parseViolation(frame.payload, runId));
        } else if (frame.kind === GuestFrameKind.Exit) complete(parseExit(frame.payload));
        else if (frame.kind === GuestFrameKind.Error || frame.kind === GuestFrameKind.Unsupported) {
          const value = parseJson(frame.payload, 'error') as { message?: unknown };
          fail(new Error(typeof value.message === 'string' ? value.message : 'guest rejected the run'), false);
        } else fail(new Error(`vsock protocol: unsupported guest frame ${frame.kind}`));
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  sock.on('error', (error) => fail(new Error(`vsock transport failed: ${error.message}`)));
  sock.on('close', () => {
    if (!settled) fail(new Error('vsock transport closed before the guest confirmed exit'));
  });

  const stdin: SandboxStdin = {
    async write(data) {
      const bytes = typeof data === 'string' ? Buffer.from(data) : data;
      for (let offset = 0; offset < bytes.byteLength; offset += MAX_STREAM_FRAME_BYTES) {
        send(HostFrameKind.Stdin, bytes.subarray(offset, offset + MAX_STREAM_FRAME_BYTES));
      }
    },
    async end() {
      send(HostFrameKind.CloseStdin);
    }
  };
  const terminal: SandboxTerminal | undefined = terminalOptions
    ? {
        async write(data) {
          if (terminalClosed || settled) return;
          const bytes = typeof data === 'string' ? Buffer.from(data) : data;
          for (let offset = 0; offset < bytes.byteLength; offset += MAX_STREAM_FRAME_BYTES) {
            send(HostFrameKind.Stdin, bytes.subarray(offset, offset + MAX_STREAM_FRAME_BYTES));
          }
        },
        async close() {
          if (terminalClosed || settled) return;
          terminalClosed = true;
          send(HostFrameKind.CloseStdin);
        },
        async resize(cols, rows) {
          if (terminalClosed || settled) return;
          send(HostFrameKind.Resize, jsonPayload(terminalSize(cols, rows)));
        }
      }
    : undefined;

  return {
    get pid() {
      return pid;
    },
    stdout: stdout.readable,
    stderr: terminalOptions ? undefined : stderr.readable,
    stdin,
    terminal,
    violations: violations.readable,
    exit,
    exited,
    get exitCode() {
      return exitCode;
    },
    kill(signal) {
      const normalized = normalizeSignal(signal);
      send(HostFrameKind.Signal, jsonPayload({ signal: normalized }));
      if (terminationTimer) clearTimeout(terminationTimer);
      terminationTimer = setTimeout(() => {
        fail(new Error(`guest did not confirm signal ${normalized} within the termination grace period`));
      }, spec.limits?.terminateGraceMs ?? 5000);
    }
  };
}

export interface VsockReadinessOptions {
  timeoutMs?: number;
  intervalMs?: number;
  probe?: () => Promise<boolean>;
}

export async function waitForVsock(spec: VsockExecSpec, options: VsockReadinessOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 500;
  const probe = options.probe ?? (() => probeOnce(spec));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await probe().catch(() => false)) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`guest vsock agent was not ready within ${timeoutMs}ms`);
}

/** One readiness probe: run `true` in the guest via vsock, bounded by a short timeout. */
async function probeOnce(spec: VsockExecSpec): Promise<boolean> {
  const proc = vsockExec(['true'], { socketPath: spec.socketPath });
  const timeout = new Promise<number>((resolve) => setTimeout(() => resolve(-1), 4000));
  const code = await Promise.race([proc.exited, timeout]);
  if (code !== 0) proc.kill();
  return code === 0;
}

export function bridgeAsyncProcess(
  start: () => Promise<SandboxProcess>,
  onFinally?: () => void,
  terminalOptions?: SandboxTerminalOptions
): SandboxProcess {
  const stdoutTransform = new TransformStream<Uint8Array, Uint8Array>();
  const stderrTransform = new TransformStream<Uint8Array, Uint8Array>();
  const violationTransform = new TransformStream<SandboxViolation, SandboxViolation>();
  let child: SandboxProcess | null = null;
  let stdinReady = false;
  let killRequested = false;
  let killSignal: number | string | undefined;
  const stdinOperations: Array<{
    run(process: SandboxProcess): Promise<void>;
    reject(reason: unknown): void;
  }> = [];

  let resolveExit!: (value: SandboxExit) => void;
  let rejectExit!: (reason: unknown) => void;
  const exit = new Promise<SandboxExit>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  void exit.catch(() => {});

  const exited = (async (): Promise<number> => {
    try {
      child = await start();
      while (stdinOperations.length > 0) {
        for (const operation of stdinOperations.splice(0)) await operation.run(child);
      }
      stdinReady = true;
      if (killRequested) child.kill(killSignal);
      child.stdout?.pipeTo(stdoutTransform.writable).catch(() => {});
      child.stderr?.pipeTo(stderrTransform.writable).catch(() => {});
      if (child.violations) child.violations.pipeTo(violationTransform.writable).catch(() => {});
      else await violationTransform.writable.close();
      if (child.exit) child.exit.then(resolveExit, rejectExit);
      const code = await child.exited;
      if (!child.exit) resolveExit({ code, signal: null });
      return code;
    } catch (error) {
      for (const operation of stdinOperations.splice(0)) operation.reject(error);
      rejectExit(error);
      await Promise.allSettled([
        stdoutTransform.writable.close(),
        stderrTransform.writable.close(),
        violationTransform.writable.close()
      ]);
      throw error;
    } finally {
      onFinally?.();
    }
  })();

  const queueStdin = (operation: (stdin: SandboxStdin) => void | Promise<void>): Promise<void> => {
    if (child && stdinReady) {
      try {
        return Promise.resolve(operation(child.stdin ?? unavailableStdin()));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise<void>((resolve, reject) => {
      stdinOperations.push({
        reject,
        async run(process) {
          try {
            await operation(process.stdin ?? unavailableStdin());
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  };

  const queueTerminal = (operation: (terminal: SandboxTerminal) => void | Promise<void>): Promise<void> => {
    if (child && stdinReady) {
      try {
        return Promise.resolve(operation(child.terminal ?? unavailableTerminal()));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise<void>((resolve, reject) => {
      stdinOperations.push({
        reject,
        async run(process) {
          try {
            await operation(process.terminal ?? unavailableTerminal());
            resolve();
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  };

  return {
    get pid() {
      return child?.pid;
    },
    stdout: stdoutTransform.readable,
    stderr: terminalOptions ? undefined : stderrTransform.readable,
    stdin: {
      write: (data) => queueStdin((stdin) => stdin.write(data)),
      end: () => queueStdin((stdin) => stdin.end())
    },
    terminal: terminalOptions
      ? {
          write: (data) => queueTerminal((terminal) => terminal.write(data)),
          close: () => queueTerminal((terminal) => terminal.close()),
          resize: (cols, rows) => {
            terminalSize(cols, rows);
            return queueTerminal((terminal) => terminal.resize(cols, rows));
          }
        }
      : undefined,
    violations: violationTransform.readable,
    exit,
    get exitCode() {
      return child?.exitCode ?? null;
    },
    exited,
    kill(signal) {
      if (child) child.kill(signal);
      else {
        killRequested = true;
        killSignal = signal;
      }
    }
  };
}

function unavailableStdin(): SandboxStdin {
  throw new Error('sandbox process does not expose stdin');
}

function unavailableTerminal(): SandboxTerminal {
  throw new Error('sandbox process does not expose a terminal');
}
