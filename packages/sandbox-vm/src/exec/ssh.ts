// The exec channel: run argv inside the guest over ssh, tunneled through gvproxy's `-forward-sock`
// (a host-side unix socket → guest sshd). Cowork uses the same shape (its binary carries an ssh
// client + "Waiting for sshd"). ssh gives us stdin/stdout/stderr separation, the real exit code,
// signal propagation, and (later) PTY for free — no custom guest agent needed.
//
// We reach the unix socket via ssh's ProxyCommand (`nc -U <sock>`); the one-shot key in the bundle
// authenticates as the unprivileged `monad` guest user.

import type { SandboxProcess } from '@monad/sdk-atom';

export interface SshExecSpec {
  /** Host-side unix socket from gvproxy -forward-sock. */
  sshSock: string;
  /** One-shot private key (bundle.sshKey). */
  identity: string;
  /** Guest user (unprivileged). */
  user: string;
  /** Working directory inside the guest. */
  cwd?: string;
  /** Env exported before the command (proxy vars for filtered net, plus the caller's env). */
  env?: Record<string, string | undefined>;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build the remote command string: `cd <cwd> && export K=V … && exec <argv…>`. Quoting keeps the
 *  guest shell from re-splitting arguments. */
function remoteCommand(argv: string[], spec: SshExecSpec): string {
  const parts: string[] = [];
  if (spec.cwd) parts.push(`cd ${shQuote(spec.cwd)}`);
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (v !== undefined) parts.push(`export ${k}=${shQuote(v)}`);
  }
  parts.push(`exec ${argv.map(shQuote).join(' ')}`);
  return parts.join(' && ');
}

/** The ssh argv that tunnels to the guest over the forward-sock and runs the command. */
export function sshArgv(argv: string[], spec: SshExecSpec): string[] {
  return [
    'ssh',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=2',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    `ProxyCommand=nc -U ${spec.sshSock}`,
    '-i',
    spec.identity,
    `${spec.user}@placeholder`,
    remoteCommand(argv, spec)
  ];
}

/** Run argv in the guest, returning a SandboxProcess the daemon's seam bridges onto its callers. */
export function sshExec(argv: string[], spec: SshExecSpec): SandboxProcess {
  const proc = Bun.spawn(sshArgv(argv, spec), { stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' });
  return {
    pid: proc.pid,
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    stdin: proc.stdin,
    get exitCode() {
      return proc.exitCode;
    },
    exited: proc.exited,
    kill: (signal) => proc.kill(signal as number | undefined)
  };
}

export interface SshReadinessOptions {
  timeoutMs?: number;
  intervalMs?: number;
  probe?: () => Promise<boolean>;
}

/** Wait until the freshly booted guest accepts an SSH command. */
export async function waitForSsh(spec: SshExecSpec, options: SshReadinessOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 250;
  const probe =
    options.probe ??
    (async () => {
      const proc = Bun.spawn(sshArgv(['true'], spec), { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
      return (await proc.exited) === 0;
    });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await probe().catch(() => false)) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`guest ssh was not ready within ${timeoutMs}ms`);
}

/** Adapt asynchronous setup onto the synchronous SandboxProcess contract without leaving output
 * streams open when setup fails. */
export function bridgeAsyncProcess(start: () => Promise<SandboxProcess>, onFinally?: () => void): SandboxProcess {
  const stdoutTransform = new TransformStream<Uint8Array, Uint8Array>();
  const stderrTransform = new TransformStream<Uint8Array, Uint8Array>();
  let child: SandboxProcess | null = null;
  let killRequested = false;
  let killSignal: number | string | undefined;

  const exited = (async (): Promise<number> => {
    try {
      child = await start();
      if (killRequested) child.kill(killSignal);
      child.stdout?.pipeTo(stdoutTransform.writable).catch(() => {});
      child.stderr?.pipeTo(stderrTransform.writable).catch(() => {});
      return await child.exited;
    } catch (error) {
      await Promise.allSettled([stdoutTransform.writable.close(), stderrTransform.writable.close()]);
      throw error;
    } finally {
      onFinally?.();
    }
  })();

  return {
    stdout: stdoutTransform.readable,
    stderr: stderrTransform.readable,
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
