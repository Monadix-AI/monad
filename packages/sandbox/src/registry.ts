// Registry of sandbox launchers. Two tiers, selected by config:
//   • LIGHT — a CLOSED internal set of OS-primitive launchers (Seatbelt / bwrap / Landlock /
//     AppContainer / Low-Integrity). These are NOT atoms and are NOT registered through the atom
//     gate; they always exist. `backend:'auto'` (the default) picks the first LIGHT launcher that is
//     a candidate for the platform.
//   • EXPLICIT — built-in VM or opt-in atom launchers contributed by an atom pack
//     (e.g. @monad/monad-power-pack) through the atom-pack loader's onSandbox sink. A heavy backend is
//     used ONLY when explicitly selected via config.sandbox.backend, never auto-selected.
//
// At boot the daemon calls selectSandboxLauncher(platform, backend) to pick which launcher confines
// spawned children and wires it into the seam via configureSandboxLauncher — the LLM-facing tools
// never change. No LIGHT candidate → noneLauncher (unconfined) so the daemon still runs, with a
// warning at the call site.

import type {
  SandboxBackendRef,
  SandboxEnforcement,
  SandboxLauncher,
  SandboxLauncherDescriptor
} from '@monad/sdk-atom';

import { logger } from '@monad/logger';
import { noneLauncher, sandboxBackendRefSchema, sandboxLauncherDescriptorSchema } from '@monad/sdk-atom';

import { hostSandboxPlatform } from './sandbox-platform.ts';

export type { SandboxBackendRef } from '@monad/sdk-atom';

type Backend = string;

interface Entry {
  launcher: SandboxLauncher;
  ref: SandboxBackendRef;
  descriptor: SandboxLauncherDescriptor;
}

export interface SandboxBackendDescriptorView {
  ref: SandboxBackendRef;
  descriptor: SandboxLauncherDescriptor;
  platforms?: NodeJS.Platform[];
  enforces?: SandboxEnforcement;
  available: boolean;
}

// The closed set of light OS launchers, in priority order (first match wins on auto):
//   macOS  → Seatbelt · Linux → bwrap → Landlock · Windows → AppContainer → Low-Integrity.
// Explicit built-in and atom-pack launchers. Contributed entries are wiped on hot-reload; built-ins remain.
const entries = new Map<string, Entry>();

function refKey(ref: SandboxBackendRef): string {
  return ref.source === 'builtin' ? `builtin/${ref.kind}` : `atom-pack/${ref.packId}/${ref.kind}`;
}

function cloneDescriptor(descriptor: SandboxLauncherDescriptor): SandboxLauncherDescriptor {
  return {
    name: descriptor.name,
    ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
    ...(descriptor.settings === undefined
      ? {}
      : { settings: { fields: descriptor.settings.fields.map((field) => structuredClone(field)) } })
  };
}

// Backend options the daemon passes to heavy launchers WITHOUT importing them (both depend on
// @monad/sandbox). Module-level state, set at boot before selection.
let backendOptions: { dockerImage?: string } = {};

/** Wire backend options (e.g. the docker image) at daemon boot, before launcher selection. */
export function configureSandboxBackendOptions(opts: { dockerImage?: string }): void {
  backendOptions = { ...opts };
}

/** The configured backend options, for a heavy launcher's spawn(). */
export function sandboxBackendOptions(): { dockerImage?: string } {
  return backendOptions;
}

/** Register an explicitly selectable launcher under its trusted, source-qualified identity. */
export function registerSandboxLauncher(launcher: SandboxLauncher, ref: SandboxBackendRef): void {
  const trustedRef = sandboxBackendRefSchema.parse(ref);
  const descriptor = sandboxLauncherDescriptorSchema.parse(launcher.descriptor);
  if (launcher.kind !== trustedRef.kind) {
    throw new Error(`sandbox launcher kind "${launcher.kind}" does not match registration kind "${trustedRef.kind}"`);
  }
  const key = refKey(trustedRef);
  if (entries.has(key)) throw new Error(`sandbox launcher already registered: ${key}`);
  entries.set(key, { launcher, ref: trustedRef, descriptor });
}

/** Drop contributed launchers for hot reload. Tests may explicitly include built-ins. */
export function clearSandboxLaunchers(options: { includeBuiltin?: boolean } = {}): void {
  for (const [key, entry] of entries) {
    if (options.includeBuiltin || entry.ref.source === 'atom-pack') entries.delete(key);
  }
}

/** Serializable registry snapshot. Runtime functions and settings values never cross this boundary. */
export function listSandboxBackendDescriptors(): SandboxBackendDescriptorView[] {
  const auto: SandboxBackendDescriptorView = {
    ref: { source: 'builtin', kind: 'auto' },
    descriptor: {
      name: 'Automatic',
      description: 'Selects the best available lightweight sandbox for this host.'
    },
    platforms: undefined,
    enforces: undefined,
    available: true
  };
  return [
    auto,
    ...[...entries.values()].map(({ ref, launcher, descriptor }) => ({
      ref: structuredClone(ref),
      descriptor: cloneDescriptor(descriptor),
      platforms: launcher.platforms ? [...launcher.platforms] : undefined,
      enforces: launcher.enforces ? structuredClone(launcher.enforces) : undefined,
      available: launcher.isAvailable?.() ?? true
    }))
  ];
}

/** Resolve one exact identity. Built-in auto is virtual and resolves for the requested platform. */
export function resolveSandboxLauncher(
  ref: SandboxBackendRef,
  platform: NodeJS.Platform = process.platform
): SandboxLauncher | undefined {
  if (ref.source === 'builtin' && ref.kind === 'auto') return selectAuto(platform);
  return entries.get(refKey(ref))?.launcher;
}

export function resolveRegisteredSandboxLauncher(kind: string): SandboxLauncher | undefined {
  const matching = [...entries.values()].filter((entry) => entry.launcher.kind === kind);
  if (matching.length > 1) {
    logger.warn(
      `monad: ${matching.length} sandbox launchers registered for backend "${kind}" — using the first, shadowing the rest`
    );
  }
  return matching[0]?.launcher;
}

/** Tell every launcher (light + heavy) to release a session's per-session resources when it ends.
 *  Only a launcher that keeps per-session state (e.g. a cloud launcher's reused remote instance)
 *  acts; the rest no-op. */
export function disposeSandboxSession(sessionId: string): void {
  for (const l of hostSandboxPlatform.launchers) void l.disposeSession?.(sessionId);
  for (const e of entries.values()) void e.launcher.disposeSession?.(sessionId);
}

/** Tell every launcher to release an agent's per-agent resources when the agent is deleted or its
 *  sandbox config changes. Only a launcher that keeps per-agent state (the VM backend's one VM per
 *  agent) acts; the rest no-op. Destroying the instance here is a security constraint — a stale
 *  instance must never outlive the policy it was built for. */
export function disposeSandboxAgent(agentId: string): void {
  for (const l of hostSandboxPlatform.launchers) void l.disposeAgent?.(agentId);
  for (const e of entries.values()) void e.launcher.disposeAgent?.(agentId);
}

function isCandidate(launcher: SandboxLauncher, platform: NodeJS.Platform): boolean {
  if (launcher.platforms && !launcher.platforms.includes(platform)) return false;
  return launcher.isAvailable?.() ?? true;
}

function selectAuto(platform: NodeJS.Platform): SandboxLauncher {
  return hostSandboxPlatform.launchers.find((l) => isCandidate(l, platform)) ?? noneLauncher;
}

export function prepareSandboxHost(): Promise<void> {
  return hostSandboxPlatform.prepareHost();
}

export function disposeSandboxHost(): Promise<void> {
  return hostSandboxPlatform.disposeHost();
}

/**
 * Pick the launcher for the platform and configured backend:
 *   • 'auto' → the first LIGHT launcher that is a candidate (platform + available), else noneLauncher.
 *     No heavy atom launcher is ever auto-selected.
 *   • 'docker' | 'e2b' | 'vm' → a registered heavy launcher whose kind === backend, returned EVEN IF
 *     isAvailable() is currently false (its prepare() runs later, then finalize re-checks). If no heavy
 *     launcher of that kind is registered (pack not enabled), warn and fall back to the auto light default.
 */
export function selectSandboxLauncher(
  platform: NodeJS.Platform = process.platform,
  backend: Backend | SandboxBackendRef = 'auto'
): SandboxLauncher {
  if (typeof backend !== 'string') {
    const exact = resolveSandboxLauncher(backend, platform);
    if (exact) return exact;
    logger.warn(`monad: sandbox backend "${refKey(backend)}" is not registered — falling back to built-in auto.`);
    return selectAuto(platform);
  }
  if (backend === 'auto') return selectAuto(platform);

  const chosen = resolveRegisteredSandboxLauncher(backend);
  if (chosen) return chosen;

  logger.warn(
    `monad: agent.sandbox.backend="${backend}" but no "${backend}" sandbox launcher is registered ` +
      '(is the atom pack that provides it enabled?) — falling back to the light OS sandbox.'
  );
  return selectAuto(platform);
}
