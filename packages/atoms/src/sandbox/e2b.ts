import type { SandboxLauncher, SandboxPolicy, SandboxProcess, SandboxSpawnOptions } from '@monad/sdk-atom';
import type { Sandbox } from 'e2b';

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { sandboxCredential } from '@monad/sdk-atom';

// The API key. In the daemon it flows from config (agent.sandbox.credential) — injected per-run via
// SandboxSpawnOptions.credential and readable via sandboxCredential() for isAvailable(). configureE2bApiKey
// is an extra override for standalone use / tests.
let configuredKey: string | undefined;
export function configureE2bApiKey(key: string | undefined): void {
  configuredKey = key;
}

function resolveKey(perRun?: string): string | undefined {
  return perRun ?? sandboxCredential() ?? configuredKey;
}

// The e2b module is loaded lazily (only when a run actually happens) and is injectable so the
// orchestration can be exercised offline against a fake SDK.
type E2bModule = typeof import('e2b');
let loadE2b: () => Promise<E2bModule> = () => import('e2b');
/** Test seam: swap the e2b SDK for a fake. Pass undefined to restore the real import. */
export function __setE2bLoaderForTest(fn: (() => Promise<E2bModule>) | undefined): void {
  loadE2b = fn ?? (() => import('e2b'));
}

// A push-fed byte stream: the launcher pumps the remote run's stdout/stderr callbacks into it and
// the daemon's caller reads it exactly as it reads a local child's piped stream (`new Response(s)`).
function pushStream(): { stream: ReadableStream<Uint8Array>; push: (s: string) => void; close: () => void } {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    }
  });
  return {
    stream,
    push: (s) => {
      if (!closed) ctrl.enqueue(enc.encode(s));
    },
    close: () => {
      if (!closed) {
        closed = true;
        ctrl.close();
      }
    }
  };
}

function cleanEnv(env: SandboxSpawnOptions['env']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

// FILE STAGING: code_execute writes the snippet to a LOCAL temp file and passes its path in argv;
// that path does not exist in the remote sandbox. Upload every argv entry that is a real local file,
// rewriting it to a remote path. (A cleaner long-term design has code_execute pass the code STRING.)
async function stageLocalFiles(sandbox: Sandbox, argv: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('/') && existsSync(arg) && statSync(arg).isFile()) {
      const remote = `/home/user/${basename(arg)}`;
      await sandbox.files.write(remote, readFileSync(arg, 'utf8'));
      out.push(remote);
    } else {
      out.push(arg);
    }
  }
  return out;
}

// One reused remote sandbox per session (keyed by SandboxSpawnOptions.sessionId), so a session's
// many code_execute/shell_exec calls share a warm micro-VM instead of paying create+destroy each
// time. Disposed when the session ends (disposeSession). Runs with no sessionId are one-shot.
const sessionSandboxes = new Map<string, Promise<Sandbox>>();

export const e2bLauncher: SandboxLauncher = {
  kind: 'e2b',
  // Cloud launcher: execution is delegated off-box, so it confines on ANY host platform.
  platforms: undefined,
  // The remote micro-VM is strongly isolated from the host — writes, credential reads, and egress
  // are all contained to the disposable remote environment.
  enforces: { writeConfine: true, readDeny: true, net: ['none', 'filtered', 'unrestricted'] },
  isAvailable: () => Boolean(resolveKey()),
  spawn(argv: string[], options: SandboxSpawnOptions, _policy: SandboxPolicy): SandboxProcess {
    const apiKey = resolveKey(options.credential);
    if (!apiKey) {
      throw new Error('e2b launcher: no API key (configure agent.sandbox credential or call configureE2bApiKey)');
    }
    const out = pushStream();
    const err = pushStream();
    let exitCode: number | null = null;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((r) => {
      resolveExit = r;
    });
    let killRemote: (() => void) | undefined;

    const sessionId = options.sessionId;
    void (async () => {
      try {
        const { Sandbox } = await loadE2b();
        let sandbox: Sandbox;
        if (sessionId) {
          let pending = sessionSandboxes.get(sessionId);
          if (!pending) {
            pending = Sandbox.create({ apiKey });
            sessionSandboxes.set(sessionId, pending);
          }
          sandbox = await pending;
        } else {
          sandbox = await Sandbox.create({ apiKey });
        }
        killRemote = sessionId ? undefined : () => void sandbox.kill();
        const remoteArgv = await stageLocalFiles(sandbox, argv);
        const res = await sandbox.commands.run(remoteArgv.join(' '), {
          cwd: options.cwd,
          envs: cleanEnv(options.env),
          onStdout: (d) => out.push(d),
          onStderr: (d) => err.push(d)
        });
        exitCode = res.exitCode;
        if (!sessionId) await sandbox.kill();
      } catch (e) {
        err.push(`e2b launcher error: ${e instanceof Error ? e.message : String(e)}\n`);
        exitCode = 1;
      } finally {
        out.close();
        err.close();
        resolveExit(exitCode ?? 1);
      }
    })();

    return {
      pid: undefined,
      stdout: out.stream,
      stderr: err.stream,
      get exitCode() {
        return exitCode;
      },
      exited,
      kill: () => killRemote?.()
    };
  },
  disposeSession(sessionId: string): Promise<void> | void {
    const pending = sessionSandboxes.get(sessionId);
    if (!pending) return;
    sessionSandboxes.delete(sessionId);
    return pending
      .then((s) => {
        void s.kill();
      })
      .catch(() => {});
  }
};
