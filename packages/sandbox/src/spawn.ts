// The single OS-sandbox seam every child process passes through. code_execute, shell_exec,
// and process_start all ultimately `Bun.spawn(argv, { cwd })` — without OS confinement that
// child has the daemon's full privileges (see code-exec.ts security note). Routing every spawn
// through sandboxedSpawn lets a per-OS launcher (Seatbelt / Landlock / AppContainer) wrap the
// argv before it runs, while the caller's timeout/abort/stream handling stays untouched.
//
// The launcher is the `sandbox` atom kind: built-in launchers (in @monad/atoms) and any third-party
// one register through the atom-pack loader, and the daemon picks one per platform at boot via the
// registry, wiring it here with configureSandboxLauncher. Until then the default is `none` (identity).

import type { SandboxLauncher, SandboxPolicy, SandboxSpawnOptions } from '@monad/sdk-atom';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noneLauncher, sandboxCredential } from '@monad/sdk-atom';

// The launcher contract (SandboxLauncher / SandboxPolicy) and the passthrough noneLauncher live in
// @monad/sdk-atom — the `sandbox` atom kind — so launchers in @monad/atoms and third-party packs
// share one definition. Re-exported here so the daemon's many sandbox consumers keep importing from
// the tools barrel unchanged.
export type { SandboxLauncher, SandboxPolicy } from '@monad/sdk-atom';

export { noneLauncher } from '@monad/sdk-atom';

let activeLauncher: SandboxLauncher = noneLauncher;

interface SandboxTerminal {
  write(input: string): void;
  close(): void;
  resize(cols: number, rows: number): void;
}

export interface SandboxPtySpawnOptions {
  cwd?: string | URL;
  env?: Record<string, string | undefined>;
  detached?: boolean;
  terminal: {
    cols?: number;
    rows?: number;
    data(terminal: SandboxTerminal, data: Uint8Array): void;
  };
}

export type SandboxPtyProcess = Bun.Subprocess<'ignore', 'ignore', 'ignore'> & { terminal?: SandboxTerminal };

/** Wire the OS launcher once at daemon boot (per platform). Unset → `none`. */
export function configureSandboxLauncher(launcher: SandboxLauncher): void {
  activeLauncher = launcher;
}

export function sandboxLauncher(): SandboxLauncher {
  return activeLauncher;
}

interface TrackableSandboxProcess {
  readonly pid?: number;
  readonly exited: Promise<unknown>;
  kill(signal?: number | string): void;
}

// Process-tree tracking is a daemon concern (shutdown reaping); @monad/sandbox stays daemon-agnostic so
// it can also back a standalone `msr`. The daemon injects its tracker at boot via
// configureSandboxProcessTracker; unset → tracking is a no-op and the spawned child is simply untracked.
export interface SandboxProcessTracker {
  track(pid: number | undefined, label: string, fallbackKill: () => void): void;
  untrack(pid: number | undefined): void;
}

let processTracker: SandboxProcessTracker | undefined;

export function configureSandboxProcessTracker(tracker: SandboxProcessTracker | undefined): void {
  processTracker = tracker;
}

function trackSandboxProcess(process: TrackableSandboxProcess, label = 'sandboxed-spawn'): void {
  processTracker?.track(process.pid, label, () => process.kill('SIGTERM'));
  void process.exited.then(() => processTracker?.untrack(process.pid));
}

// Network policy is daemon-wide config; writable roots are per-call. buildSandboxPolicy() unifies
// the two so the three spawn sites construct identical policies. Defaults to 'unrestricted' (the
// proxy that backs 'none'/'{allowProxyPort}' is a later phase).
let netDefault: SandboxPolicy['net'] = 'unrestricted';

/** Wire the daemon-wide network policy at boot. */
export function configureSandboxNet(net: SandboxPolicy['net']): void {
  netDefault = net;
}

export function sandboxNetMode(): SandboxPolicy['net'] {
  return netDefault;
}

// Sensitive paths every confined child is denied read access to (credential dir, SSH/cloud keys).
// Daemon-wide, resolved once at boot from the real home — see configureSandboxReadDeny.
let readDenyDefault: string[] = [];

/** Wire the daemon-wide read-deny roots at boot (credential/secret dirs). */
export function configureSandboxReadDeny(roots: string[]): void {
  readDenyDefault = roots;
}

// Masked credential files (real→fake binds) applied to every confined spawn. Daemon-wide, built
// once at boot from a MaskedFileStore — see configureSandboxMaskedFiles.
let maskedFilesDefault: { real: string; fake: string }[] = [];

/** Wire the daemon-wide masked credential files at boot (real→fake read-only binds). */
export function configureSandboxMaskedFiles(files: { real: string; fake: string }[]): void {
  maskedFilesDefault = files;
}

// Env injected into every confined child (e.g. HTTP(S)_PROXY pointing at the local filtering proxy)
// so the child's curl/pip/npm/git route through it. Set at boot for net:'filtered'; undefined = none.
let proxyEnv: Record<string, string> | undefined;

/** Wire the proxy env vars merged into confined children at boot. Pass undefined to clear. */
export function configureSandboxProxyEnv(env: Record<string, string> | undefined): void {
  proxyEnv = env;
}

// Static env vars from agent.sandbox.env config — API base URLs, locale overrides, etc.
// Applied to ALL confined children (lower priority than proxyEnv so the proxy can override).
let extraEnv: Record<string, string> = {};

/** Wire user-configured env vars from agent.sandbox.env at daemon boot. */
export function configureSandboxExtraEnv(env: Record<string, string>): void {
  extraEnv = env;
}

/**
 * Point HOME and the common package-manager/XDG cache dirs at the sandbox's writable root, so a
 * confined child's pip/npm/cargo caches and `--user` installs land in the (disposable) sandbox
 * instead of the real home — where the write would otherwise be blocked. The tools create these
 * subdirs themselves; they're writable because they're under `home`, which is a writable root.
 */
export function sandboxHomeEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    npm_config_cache: join(home, '.npm'),
    PIP_CACHE_DIR: join(home, '.cache', 'pip')
  };
}

/**
 * Build the policy for a spawn. `writableRoots === undefined` (unrestricted-mode session) stays
 * undefined so no write confinement is applied; otherwise the roots (plus any call-specific extra
 * dirs, e.g. a snippet temp dir) form the writable surface. Network comes from daemon config.
 */
export function buildSandboxPolicy(
  writableRoots: string[] | undefined,
  extraWritable: string[] = [],
  sessionId?: string
): SandboxPolicy {
  // The system temp dir is always writable when confined: git, compilers, package managers and
  // most tooling write scratch files to TMPDIR, so omitting it would break ordinary commands. It's
  // ephemeral, so this doesn't compromise the "no host pollution" goal.
  return {
    writableRoots: writableRoots ? [...writableRoots, tmpdir(), ...extraWritable] : undefined,
    readDenyRoots: readDenyDefault,
    maskedFiles: maskedFilesDefault.length > 0 ? maskedFilesDefault : undefined,
    net: netDefault,
    sessionId
  };
}

/**
 * Drop-in for `Bun.spawn`: applies the active launcher's argv wrapping, then spawns. Mirrors
 * Bun.spawn's three stdio generics so the precise Subprocess type (piped streams, stdin) flows
 * through to callers unchanged.
 */
export function sandboxedSpawn<
  const In extends Bun.SpawnOptions.Writable = 'ignore',
  const Out extends Bun.SpawnOptions.Readable = 'pipe',
  const Err extends Bun.SpawnOptions.Readable = 'inherit'
>(
  argv: string[],
  options: Bun.SpawnOptions.SpawnOptions<In, Out, Err> | undefined,
  policy: SandboxPolicy = {},
  // confine:false escapes the sandbox entirely — no launcher wrap, no proxy env — for an explicit,
  // approval-gated host run (code_execute target:'host'). Spawns exactly like plain Bun.spawn.
  // sessionId lets a remote launcher reuse ONE off-box instance per session across calls.
  opts: { confine?: boolean; sessionId?: string } = {}
): Bun.Subprocess<In, Out, Err> {
  if (opts.confine === false) {
    const proc = Bun.spawn<In, Out, Err>(argv, { ...options, detached: true });
    trackSandboxProcess(proc, 'sandboxed-spawn');
    return proc;
  }

  // Build the env overlay for a confined child: proxy vars (network routed through the filter) plus
  // a writable HOME/cache redirect — but only when a launcher actually confines, so an inactive
  // launcher (kind 'none' — sandbox disabled, or the platform's native helper binary missing) keeps
  // today's inherited env.
  const home = policy.writableRoots?.[0];
  const overlay: Record<string, string> = {
    ...extraEnv,
    ...(proxyEnv ?? {}),
    ...(activeLauncher.kind !== 'none' && home ? sandboxHomeEnv(home) : {})
  };
  const finalOptions =
    Object.keys(overlay).length > 0
      ? ({ ...options, detached: true, env: { ...(options?.env ?? Bun.env), ...overlay } } as typeof options)
      : ({ ...options, detached: true } as typeof options);
  // A REMOTE launcher (cloud sandbox: e2b/Vercel) exposes spawn() instead of wrap() — it runs the
  // process off-box and returns a SandboxProcess. The three call sites consume only that subset
  // (stdout/stderr/stdin/exited/exitCode/kill/pid), so the handle bridges onto Bun.Subprocess's
  // callers unchanged; the cast is the seam's single point of structural reconciliation.
  if (!activeLauncher.wrap && activeLauncher.spawn) {
    const spawnOptions: SandboxSpawnOptions = {
      cwd: finalOptions?.cwd ? String(finalOptions.cwd) : undefined,
      env: finalOptions?.env as Record<string, string | undefined> | undefined,
      credential: sandboxCredential(),
      sessionId: opts.sessionId
    };
    return activeLauncher.spawn(argv, spawnOptions, policy) as unknown as Bun.Subprocess<In, Out, Err>;
  }
  // LOCAL launchers (all built-ins) expose wrap(): rewrite argv, then Bun.spawn here.
  if (!activeLauncher.wrap) {
    throw new Error(`Sandbox launcher (${activeLauncher.kind}) implements neither wrap() nor spawn()`);
  }
  let wrapped: string[];
  try {
    wrapped = activeLauncher.wrap(argv, policy);
  } catch (err) {
    throw new Error(
      `Sandbox launcher (${activeLauncher.kind}) failed to build argv: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const proc = Bun.spawn<In, Out, Err>(wrapped, finalOptions);
  trackSandboxProcess(proc, 'sandboxed-spawn');
  return proc;
}

export function sandboxedPtySpawn(
  argv: string[],
  options: SandboxPtySpawnOptions,
  policy: SandboxPolicy = {},
  opts: { confine?: boolean; sessionId?: string } = {}
): SandboxPtyProcess {
  if (!activeLauncher.wrap && activeLauncher.spawn) {
    throw new Error(`Sandbox launcher (${activeLauncher.kind}) does not support PTY processes`);
  }
  return sandboxedSpawn(
    argv,
    options as Bun.SpawnOptions.SpawnOptions<'ignore', 'ignore', 'ignore'>,
    policy,
    opts
  ) as SandboxPtyProcess;
}
