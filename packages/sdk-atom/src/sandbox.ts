// The sandbox-launcher contract — the `sandbox` atom kind. A launcher is the OS/remote mechanism
// that confines a spawned child (code_execute / shell_exec / process_start). Tools are first-party
// and never atoms (they live in the daemon); the LAUNCHER under them is the pluggable atom: the
// daemon owns the single `sandboxedSpawn` seam and per-call policy, while which mechanism actually
// confines the child — Seatbelt, Landlock, Low-Integrity, or a future cloud backend (e2b / Vercel) —
// is selected from the registry of launchers contributed by atom packs (built-in + third-party).
//
// Two execution models, one contract:
//   • LOCAL  — `wrap(argv, policy)` rewrites argv (e.g. prepend `sandbox-exec -p <profile>`); the
//              host then runs it with its own Bun.spawn. This is the common case.
//   • REMOTE — `spawn(argv, options, policy)` runs the process itself (local or on a remote API) and
//              returns a process handle. Cloud sandboxes implement this instead of `wrap`. Reserved
//              for a later phase; the contract carries it so adding e2b/Vercel needs no re-architecture.

/** What the child is allowed to touch. A launcher translates this into an OS/remote policy; `none`
 *  ignores it. Owned here (not in the daemon) so launchers in @monad/atoms and third-party packs
 *  share one definition without depending on the app. */
export interface SandboxPolicy {
  /** The only paths the child may write to (session-scoped ephemeral root, snippet dir, …).
   *  `undefined` means no write confinement (e.g. an unrestricted-mode session). */
  writableRoots?: string[];
  /** Extra read-only paths the child needs (interpreters, system libraries, …). */
  readableRoots?: string[];
  /** Paths the child may NOT read even under allow-default — credential stores, SSH/cloud keys.
   *  Blocks the read-then-exfiltrate chain regardless of net mode. */
  readDenyRoots?: string[];
  /** 'none' = no egress; { allowProxyPort } = only the local filtering proxy; 'unrestricted' = open. */
  net?: 'none' | { allowProxyPort: number } | 'unrestricted';
}

/** What a launcher declares it actually enforces, so the daemon can log honestly at boot WITHOUT
 *  hardcoding per-launcher `kind` checks — a new launcher describes its own containment here. */
export interface SandboxEnforcement {
  /** Restricts filesystem writes to the policy's writable roots. */
  writeConfine?: boolean;
  /** Denies reads of the policy's readDenyRoots (credential/secret dirs). */
  readDeny?: boolean;
  /** Which `net` modes the launcher actually enforces at its own layer. A mode absent here is
   *  advisory only (e.g. Landlock can enforce 'none' in-kernel but not 'filtered'). */
  net?: ('none' | 'filtered' | 'unrestricted')[];
}

/** Provider-agnostic spawn options for the REMOTE execution model. Kept loose and free of Bun types
 *  so a cloud backend (e2b / Vercel) can satisfy it without importing the daemon's runtime. */
export interface SandboxSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Credential the daemon resolved for this launcher (e.g. a cloud sandbox API key). Undefined when
   *  none is configured — a launcher that needs one should fail clearly. */
  credential?: string;
  /** The session this run belongs to, so a launcher can keep ONE remote instance per session and
   *  reuse it across calls (disposed when the session ends). Undefined for non-session runs. */
  sessionId?: string;
  [key: string]: unknown;
}

/** The minimal process handle the daemon's spawn sites consume (code_execute/shell_exec/process_start
 *  read exactly these fields) — the seam that lets a REMOTE launcher return a non-Bun handle. A LOCAL
 *  launcher's child (a real Bun.Subprocess) satisfies this shape structurally, so the daemon's seam
 *  bridges either onto the same callers without change.
 *
 *  A cloud launcher builds `stdout`/`stderr` as ReadableStreams fed from the remote run's output and
 *  resolves `exited` with the remote exit code — see the e2b example in examples/e2b/. */
export interface SandboxProcess {
  /** Remote PID/handle id, if any (process_start reports it; cloud launchers may omit). */
  readonly pid?: number;
  /** Child stdout as a byte stream (undefined when not piped). Callers do `new Response(stdout)`. */
  readonly stdout?: ReadableStream<Uint8Array>;
  readonly stderr?: ReadableStream<Uint8Array>;
  /** Writable stdin handle, if the run accepts input (process_start writes to it). Shape is
   *  launcher-defined (a Bun FileSink locally); callers treat it opaquely. */
  readonly stdin?: unknown;
  /** Resolves with the exit code when the run finishes. */
  readonly exited: Promise<number>;
  /** Exit code once known, else null (still running). */
  readonly exitCode?: number | null;
  /** Terminate the run. */
  kill(signal?: number | string): void;
}

export interface SandboxLauncher {
  /** Stable identifier — 'none' | 'seatbelt' | 'landlock' | 'lowintegrity' | 'bwrap' | 'e2b' | … */
  readonly kind: string;
  /** Platforms this launcher can confine on (process.platform values). `undefined` = any platform
   *  (e.g. a cloud launcher that delegates execution off-box). */
  readonly platforms?: NodeJS.Platform[];
  /** Declared containment, for honest boot logging. */
  readonly enforces?: SandboxEnforcement;
  /** Runtime availability — native binary present, API key configured, etc. Absent → always available. */
  isAvailable?(): boolean;
  /** LOCAL model: rewrite argv to apply confinement; the host runs the result. */
  wrap?(argv: string[], policy: SandboxPolicy): string[];
  /** REMOTE model (forward-looking): run the process and return a handle. Implement instead of `wrap`. */
  spawn?(argv: string[], options: SandboxSpawnOptions, policy: SandboxPolicy): SandboxProcess;
  /** Release any per-session resources when the session ends — e.g. a cloud launcher that keeps ONE
   *  remote instance per `SandboxSpawnOptions.sessionId` and reuses it across calls disposes it here.
   *  Optional: local launchers keep no per-session state. */
  disposeSession?(sessionId: string): void | Promise<void>;
}

// The host's configured sandbox credential (a cloud launcher's API key), resolved from config at
// boot. A cloud launcher reads it in BOTH isAvailable() (the daemon's registry probes availability
// before any run) and spawn() — and it is the only host→launcher channel a third-party launcher
// PACKAGE can share with the daemon (both depend on @monad/sdk-atom). Undefined = none configured.
let credentialState: string | undefined;

/** Wire the resolved cloud-sandbox credential at daemon boot. */
export function configureSandboxCredential(credential: string | undefined): void {
  credentialState = credential;
}

/** The configured cloud-sandbox credential, for a launcher's isAvailable()/spawn(). */
export function sandboxCredential(): string | undefined {
  return credentialState;
}

/** Passthrough launcher — no OS confinement on the spawned child. The daemon's fallback when no real
 *  launcher matches the platform / is available. */
export const noneLauncher: SandboxLauncher = {
  kind: 'none',
  platforms: undefined,
  enforces: {},
  isAvailable: () => true,
  wrap: (argv) => argv
};

/** Declarative sugar for a LOCAL (argv-wrapping) launcher — the common case for an OS launcher.
 *  Mirrors defineProvider/defineChannel: keeps built-in launchers free of boilerplate. */
export function defineLocalLauncher(spec: {
  kind: string;
  platforms?: NodeJS.Platform[];
  enforces?: SandboxEnforcement;
  isAvailable?: () => boolean;
  wrap: (argv: string[], policy: SandboxPolicy) => string[];
}): SandboxLauncher {
  return {
    kind: spec.kind,
    platforms: spec.platforms,
    enforces: spec.enforces,
    isAvailable: spec.isAvailable,
    wrap: spec.wrap
  };
}
