// The exec channel: run argv inside the guest over vsock (a direct host↔guest transport, independent
// of the guest NIC). vfkit bridges a host unix socket to the guest's vsock port where monad-vsock-agent
// listens; we speak a small framed protocol over it. Unlike ssh this needs no sshd, no key, and no
// guest NIC — so net:'none' can drop the network device entirely. Mirrors Claude Cowork's vsock RPC.
//
// Wire protocol (big-endian), matching native/vsock-agent/main.go:
//   request  (host→guest): [len:u32][json]   json = {argv, cwd, env}
//   response (guest→host): [channel:u8][len:u32][data]   channel 1=stdout 2=stderr 3=exit(u32 code)

import type { SandboxProcess } from '@monad/sdk-atom';

import { connect } from 'node:net';

export interface VsockExecSpec {
  /** The host endpoint bridging to the guest's vsock exec port: a unix socket (vfkit exposes it
   *  directly on macOS; socat bridges it on Linux) or a named pipe `\\.\pipe\…` (winvm-helper
   *  bridges hvsock on Windows — node's connect(path) dials pipes there natively). */
  socketPath: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

const CH_STDOUT = 1;
const CH_STDERR = 2;
const CH_EXIT = 3;

function encodeRequest(argv: string[], spec: VsockExecSpec): Buffer {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env ?? {})) if (v !== undefined) env[k] = v;
  const json = Buffer.from(JSON.stringify({ argv, cwd: spec.cwd, env }), 'utf8');
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(json.length, 0);
  return Buffer.concat([hdr, json]);
}

/** Run argv in the guest over vsock, returning a SandboxProcess the daemon's seam consumes. */
export function vsockExec(argv: string[], spec: VsockExecSpec): SandboxProcess {
  const sock = connect(spec.socketPath);
  let exitCode: number | null = null;

  const stdout = new TransformStream<Uint8Array, Uint8Array>();
  const stderr = new TransformStream<Uint8Array, Uint8Array>();
  const outW = stdout.writable.getWriter();
  const errW = stderr.writable.getWriter();

  // Demux the response frame stream. Frames may span TCP reads, so buffer until a full frame is in.
  let buf = Buffer.alloc(0);
  const pump = () => {
    while (buf.length >= 5) {
      const ch = buf[0] as number;
      const len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) break;
      const data = buf.subarray(5, 5 + len);
      if (ch === CH_STDOUT) void outW.write(new Uint8Array(data));
      else if (ch === CH_STDERR) void errW.write(new Uint8Array(data));
      else if (ch === CH_EXIT) exitCode = data.readUInt32BE(0);
      buf = buf.subarray(5 + len);
    }
  };

  sock.on('connect', () => sock.write(encodeRequest(argv, spec)));
  sock.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    pump();
  });

  const exited = new Promise<number>((resolve) => {
    const finish = () => {
      void outW.close().catch(() => {});
      void errW.close().catch(() => {});
      // No exit frame received (connection dropped mid-run) → treat as killed.
      if (exitCode === null) exitCode = 137;
      resolve(exitCode);
    };
    sock.on('close', finish);
    sock.on('error', finish);
  });

  return {
    stdout: stdout.readable,
    stderr: stderr.readable,
    get exitCode() {
      return exitCode;
    },
    exited,
    kill: () => sock.destroy()
  };
}

export interface VsockReadinessOptions {
  timeoutMs?: number;
  intervalMs?: number;
  probe?: () => Promise<boolean>;
}

/** Poll the guest with a trivial vsock command until the agent answers (booted + agent up) or the
 *  timeout elapses. vfkit returns as soon as the process spawns, long before CoreOS finishes booting. */
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

/** Bridge an async process-start onto a synchronous SandboxProcess: the streams are wired when the
 *  underlying child starts, `exited` resolves with its code, and a kill issued before the child
 *  exists is applied once it starts. `onFinally` runs when the run settles (e.g. pool refcount
 *  release). Closes the transforms on a start failure so readers don't hang. */
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
