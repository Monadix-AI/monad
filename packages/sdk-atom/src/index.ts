// Deferred: the gate() hook that routes high-risk tool calls through human approval
// arrives with the oversight phase.

import type { AtomKind, AtomPackManifestWire, MessageTypeDescriptor } from '@monad/protocol';
import type { ChannelDefinition } from './channel.ts';
import type { Connector } from './connector.ts';
import type { HookDefinition } from './hook.ts';
import type { ModelProvider } from './model.ts';
import type { SandboxLauncher } from './sandbox.ts';

export * from './channel.ts';
export * from './command.ts';
export * from './connector.ts';
export * from './hook.ts';
export * from './locale.ts';
export * from './message-type.ts';
export * from './model.ts';
export * from './provider-usage.ts';
export * from './sandbox.ts';

/** The SDK contract version. Atom packs are built against it; the host checks compatibility at load.
 *  Single source of truth — bump when the atom pack/channel contract changes incompatibly. */
export const SDK_VERSION = '0';

/** Registration-type atom kinds — fully enforced in-process via the gated AtomPackContext.
 *  Resource-type kinds (network/fs/llm) are audit-only until atom packs run out-of-process. Aliased
 *  to the protocol's AtomKind so the manifest schema and the host agree on one set. */
export type Atom = AtomKind;

export class UndeclaredAtomError extends Error {
  constructor(
    readonly atom: Atom,
    readonly atomPack: string
  ) {
    super(`atom pack "${atomPack}" used undeclared atom kind "${atom}" (add it to manifest.atoms)`);
    this.name = 'UndeclaredAtomError';
  }
}

/** The manifest shape, derived from the protocol's zod schema (single source of truth). */
export type AtomPackManifest = AtomPackManifestWire;

export type AtomPackLog = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;

/** The host facade passed to register(). Every registerX is gated by manifest.atoms.
 *  skill/mcp/locale are file-based and do NOT appear here — they are installed at the
 *  atom-pack-manager level and discovered from disk at daemon startup.
 *  Tools are NOT an atom kind: they are always first-party and built into the daemon, so atom
 *  packs cannot register them. */
export interface AtomPackContext {
  registerConnector(connector: Connector): void;
  registerChannel(channel: ChannelDefinition): void;
  registerCommand(command: unknown): void;
  /** Register a custom message type. The host namespaces it under the atom pack id, so the rendered
   * wire `type` becomes `<atomPackId>:<descriptor.type>`. */
  registerMessageType(descriptor: MessageTypeDescriptor): void;
  registerProvider(provider: ModelProvider): void;
  registerHook(hook: HookDefinition): void;
  /** Register an OS/remote sandbox launcher. The daemon collects launchers into a registry and
   *  selects one per platform at boot — the LLM-facing tools (code_execute/…) are unchanged. */
  registerSandbox(launcher: SandboxLauncher): void;
  log: AtomPackLog;
}

export interface ManifestAtomPack {
  manifest: AtomPackManifest;
  register(ctx: AtomPackContext): void | Promise<void>;
}

/** What the daemon implements to receive gated registrations. */
export interface ManifestAtomPackHost {
  registerConnector(connector: Connector): void;
  registerChannel(channel: ChannelDefinition): void;
  registerCommand(command: unknown): void;
  /** `atomPackId` lets the host namespace the type (delegates to the protocol registry). */
  registerMessageType(atomPackId: string, descriptor: MessageTypeDescriptor): void;
  /** Optional: hosts that don't support model providers omit it; a provider registration then
   *  throws so a mis-targeted atom pack fails loudly rather than silently dropping. */
  registerProvider?(provider: ModelProvider): void;
  /** Optional: hosts that don't support lifecycle hooks omit it; a hook registration then throws. */
  registerHook?(hook: HookDefinition): void;
  /** Optional: hosts that don't support sandbox launchers omit it; a sandbox registration then throws. */
  registerSandbox?(launcher: SandboxLauncher): void;
  log?: AtomPackLog;
}

/** Declarative sugar: builds a register() that routes through the gated ctx — so even the sugar
 *  path enforces atom kinds (a payload array for an undeclared atom kind throws on load). */
export function defineAtomPack(spec: {
  manifest: AtomPackManifest;
  connectors?: Connector[];
  channels?: ChannelDefinition[];
  commands?: unknown[];
  messageTypes?: MessageTypeDescriptor[];
  providers?: ModelProvider[];
  hooks?: HookDefinition[];
  sandboxes?: SandboxLauncher[];
}): ManifestAtomPack {
  return {
    manifest: spec.manifest,
    register(ctx: AtomPackContext) {
      for (const connector of spec.connectors ?? []) ctx.registerConnector(connector);
      for (const channel of spec.channels ?? []) ctx.registerChannel(channel);
      for (const command of spec.commands ?? []) ctx.registerCommand(command);
      for (const mt of spec.messageTypes ?? []) ctx.registerMessageType(mt);
      for (const provider of spec.providers ?? []) ctx.registerProvider(provider);
      for (const hook of spec.hooks ?? []) ctx.registerHook(hook);
      for (const sandbox of spec.sandboxes ?? []) ctx.registerSandbox(sandbox);
    }
  };
}

/** Load a manifest atom pack: build an atom-kind-gated AtomPackContext bound to the manifest, then
 *  run register(). Registrations of undeclared atom kinds throw UndeclaredAtomError.
 *
 *  `opts.grantedAtoms`, when provided, is the AUTHORITATIVE gate set — the atom kinds the user
 *  audited and consented to (the on-disk `atom-pack.json`), NOT the bundle's self-declared
 *  `manifest.atoms`. A discovered bundle can embed any manifest it likes; trusting its own
 *  declaration would let it register atoms the user never consented to. Callers loading untrusted
 *  packs MUST pass grantedAtoms. First-party/trusted callers omit it and fall back to the pack's
 *  own manifest. */
export async function loadManifestAtomPack(
  pack: ManifestAtomPack,
  host: ManifestAtomPackHost,
  opts: { grantedAtoms?: readonly Atom[] } = {}
): Promise<void> {
  const declared = new Set<Atom>(opts.grantedAtoms ?? pack.manifest.atoms);
  const name = pack.manifest.name;
  const gate = (atom: Atom): void => {
    if (!declared.has(atom)) throw new UndeclaredAtomError(atom, name);
  };
  const ctx: AtomPackContext = {
    registerConnector: (c) => {
      gate('connector');
      host.registerConnector(c);
    },
    registerChannel: (ch) => {
      gate('channel');
      host.registerChannel(ch);
    },
    registerCommand: (cmd) => {
      gate('command');
      host.registerCommand(cmd);
    },
    registerMessageType: (d) => {
      gate('message-type');
      host.registerMessageType(name, d);
    },
    registerProvider: (p) => {
      gate('provider');
      if (!host.registerProvider) throw new Error(`host does not accept model providers (atom pack "${name}")`);
      host.registerProvider(p);
    },
    registerHook: (h) => {
      gate('hook');
      if (!host.registerHook) throw new Error(`host does not accept lifecycle hooks (atom pack "${name}")`);
      host.registerHook(h);
    },
    registerSandbox: (s) => {
      gate('sandbox');
      if (!host.registerSandbox) throw new Error(`host does not accept sandbox launchers (atom pack "${name}")`);
      host.registerSandbox(s);
    },
    log: host.log ?? (() => {})
  };
  await pack.register(ctx);
}
