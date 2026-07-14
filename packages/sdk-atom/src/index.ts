// Deferred: the gate() hook that routes high-risk tool calls through human approval
// arrives with the oversight phase.

import type { LocalePack, Translate } from '@monad/i18n';
import type {
  AtomKind,
  AtomPackManifestWire,
  ChannelCapabilities,
  ChannelEnvVar,
  ChannelInbound,
  ChannelManifest,
  ChannelType,
  CommandArg,
  CommandItem,
  CommandItemType,
  CommandSource,
  CommandSubcommand,
  GenerationParams,
  HookEvent,
  HookInput,
  HookOutput,
  InteractionRequest,
  InteractionResult,
  MessageTypeDescriptor,
  ModelInfo,
  ModelKind,
  ModelModalities,
  ModelPrice,
  ModelProviderDescriptor,
  Scope,
  WorkspaceExperienceDefinition,
  WorkspaceExperienceEntry,
  WorkspaceExperienceHostApi,
  WorkspaceExperiencePermission
} from '@monad/protocol';
import type {
  AdapterMigration,
  BuildExternalAgentLaunchOptions,
  ExternalAgentAcpDelivery,
  ExternalAgentApprovalResolution,
  ExternalAgentAppServerConnection,
  ExternalAgentArgumentSupport,
  ExternalAgentArgumentSupportProbe,
  ExternalAgentAuthStatusProbe,
  ExternalAgentErrorCode,
  ExternalAgentInitializeContext,
  ExternalAgentLaunchSpec,
  ExternalAgentManagedEnvContext,
  ExternalAgentManagedRuntime,
  ExternalAgentManagedRuntimeContext,
  ExternalAgentModelOption,
  ExternalAgentModelOptionsProbe,
  ExternalAgentObservationActivity,
  ExternalAgentObservationJsonRecordEntry,
  ExternalAgentObservationMessageGroupProjector,
  ExternalAgentObservationProjector,
  ExternalAgentObservationRecordProjector,
  ExternalAgentObservationUsageProjector,
  ExternalAgentOutputEvent,
  ExternalAgentProviderAdapter,
  ExternalAgentProviderHistoryContext,
  ExternalAgentProviderHistoryPageContext,
  ExternalAgentProviderHistoryPageRequestContext,
  ExternalAgentRuntimeHandle,
  ExternalAgentSettingsImport,
  ExternalAgentStartPreflight,
  ExternalAgentUsageProbe
} from './agent-adapter.ts';
import type { BinProbes } from './bin-probes.ts';
import type {
  ChannelAdapter,
  ChannelAdapterFactory,
  ChannelAtomConfig,
  ChannelContext,
  ChannelDefinition,
  ChannelHarnessOptions,
  ChannelLog,
  ChannelTestHarness,
  SendOptions,
  SentMessage
} from './channel.ts';
import type {
  BeliefExplanation,
  BeliefMatch,
  CommandDefinition,
  CommandEffect,
  CommandLog,
  CommandModelInfo,
  CommandResult,
  CommandRunContext,
  CommandSessionInfo,
  CommandSubcommandDefinition,
  CompactSummary,
  ConsolidateMemorySummary,
  ConsolidateSummary,
  ContradictionCheckSummary
} from './command.ts';
import type { Connector, ConnectorHost } from './connector.ts';
import type { HookDefinition, HookHandler } from './hook.ts';
import type {
  EmbedCall,
  EmbedResult,
  ImageCall,
  ImageResult,
  ModelCall,
  ModelChunk,
  ModelContentPart,
  ModelMessage,
  ModelProvider,
  ModelResult,
  ModelUsage,
  ProviderCredential,
  ProviderToolHint,
  RerankCall,
  RerankResult,
  ResolvedProviderConfig,
  SpeechCall,
  SpeechResult,
  ToolCall,
  ToolSpec,
  TranscriptionCall,
  TranscriptionResult,
  UsageLimits,
  UsageSnapshot,
  VideoCall,
  VideoResult
} from './model.ts';
import type {
  SandboxBackendRef,
  SandboxEnforcement,
  SandboxLauncher,
  SandboxLauncherDescriptor,
  SandboxPolicy,
  SandboxProcess,
  SandboxSettingsSchema,
  SandboxSpawnOptions
} from './sandbox.ts';

import { ExternalAgentError, externalAgentOutputEventSchema } from './agent-adapter.ts';
import { defaultBinProbes, resolveBinary } from './bin-probes.ts';
import { assertChannelInbound, createChannelTestHarness, defineChannel, parseChannelManifest } from './channel.ts';
import { defineCommand } from './command.ts';
import { defineProvider } from './model.ts';
import { extractCacheWrite, extractProviderCost, usageFromProviderMetadataJson } from './provider-usage.ts';
import {
  configureSandboxCredential,
  defineLocalLauncher,
  noneLauncher,
  sandboxBackendRefSchema,
  sandboxCredential,
  sandboxLauncherDescriptorSchema,
  sandboxSettingsSchema
} from './sandbox.ts';

export type {
  AdapterMigration,
  BeliefExplanation,
  BeliefMatch,
  BinProbes,
  BuildExternalAgentLaunchOptions,
  ChannelAdapter,
  ChannelAdapterFactory,
  ChannelAtomConfig,
  ChannelCapabilities,
  ChannelContext,
  ChannelDefinition,
  ChannelEnvVar,
  ChannelHarnessOptions,
  ChannelInbound,
  ChannelLog,
  ChannelManifest,
  ChannelTestHarness,
  ChannelType,
  CommandArg,
  CommandDefinition,
  CommandEffect,
  CommandItem,
  CommandItemType,
  CommandLog,
  CommandModelInfo,
  CommandResult,
  CommandRunContext,
  CommandSessionInfo,
  CommandSource,
  CommandSubcommand,
  CommandSubcommandDefinition,
  CompactSummary,
  Connector,
  ConnectorHost,
  ConsolidateMemorySummary,
  ConsolidateSummary,
  ContradictionCheckSummary,
  EmbedCall,
  EmbedResult,
  ExternalAgentAcpDelivery,
  ExternalAgentApprovalResolution,
  ExternalAgentAppServerConnection,
  ExternalAgentArgumentSupport,
  ExternalAgentArgumentSupportProbe,
  ExternalAgentAuthStatusProbe,
  ExternalAgentErrorCode,
  ExternalAgentInitializeContext,
  ExternalAgentLaunchSpec,
  ExternalAgentManagedEnvContext,
  ExternalAgentManagedRuntime,
  ExternalAgentManagedRuntimeContext,
  ExternalAgentModelOption,
  ExternalAgentModelOptionsProbe,
  ExternalAgentObservationActivity,
  ExternalAgentObservationJsonRecordEntry,
  ExternalAgentObservationMessageGroupProjector,
  ExternalAgentObservationProjector,
  ExternalAgentObservationRecordProjector,
  ExternalAgentObservationUsageProjector,
  ExternalAgentOutputEvent,
  ExternalAgentProviderAdapter,
  ExternalAgentProviderHistoryContext,
  ExternalAgentProviderHistoryPageContext,
  ExternalAgentProviderHistoryPageRequestContext,
  ExternalAgentRuntimeHandle,
  ExternalAgentSettingsImport,
  ExternalAgentStartPreflight,
  ExternalAgentUsageProbe,
  GenerationParams,
  HookDefinition,
  HookEvent,
  HookHandler,
  HookInput,
  HookOutput,
  ImageCall,
  ImageResult,
  LocalePack,
  MessageTypeDescriptor,
  ModelCall,
  ModelChunk,
  ModelContentPart,
  ModelInfo,
  ModelKind,
  ModelMessage,
  ModelModalities,
  ModelPrice,
  ModelProvider,
  ModelProviderDescriptor,
  ModelResult,
  ModelUsage,
  ProviderCredential,
  ProviderToolHint,
  RerankCall,
  RerankResult,
  ResolvedProviderConfig,
  SandboxBackendRef,
  SandboxEnforcement,
  SandboxLauncher,
  SandboxLauncherDescriptor,
  SandboxPolicy,
  SandboxProcess,
  SandboxSettingsSchema,
  SandboxSpawnOptions,
  Scope,
  SendOptions,
  SentMessage,
  SpeechCall,
  SpeechResult,
  ToolCall,
  ToolSpec,
  TranscriptionCall,
  TranscriptionResult,
  Translate,
  UsageLimits,
  UsageSnapshot,
  VideoCall,
  VideoResult,
  WorkspaceExperienceDefinition,
  WorkspaceExperienceEntry,
  WorkspaceExperienceHostApi
};

export {
  assertChannelInbound,
  configureSandboxCredential,
  createChannelTestHarness,
  defaultBinProbes,
  defineChannel,
  defineCommand,
  defineLocalLauncher,
  defineProvider,
  ExternalAgentError,
  externalAgentOutputEventSchema,
  extractCacheWrite,
  extractProviderCost,
  noneLauncher,
  parseChannelManifest,
  resolveBinary,
  sandboxBackendRefSchema,
  sandboxCredential,
  sandboxLauncherDescriptorSchema,
  sandboxSettingsSchema,
  usageFromProviderMetadataJson
};

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

/** Opaque, pack-private state exposed to a workspace experience API or worker.
 * The host enforces namespace ownership and access control; pack code owns the
 * shape and lifecycle of every stored value. */
export interface ExperienceStateStore {
  get<T>(projectId: string, key: string): Promise<{ value: T; version: number } | null>;
  list<T>(projectId: string, prefix: string): Promise<Array<{ key: string; value: T; version: number }>>;
  compareAndSwap<T>(input: {
    projectId: string;
    key: string;
    expectedVersion: number | null;
    value: T;
    event: unknown;
  }): Promise<boolean>;
}

/** Generic project-session operations available to a workspace experience.
 * These deliberately contain no product-specific task or proposal concepts. */
export interface ProjectSessionOperations {
  list(projectId: string): Promise<Array<{ id: string; title: string; state: string }>>;
  create(projectId: string, input: { title: string; cwd?: string; idempotencyKey: string }): Promise<{ id: string }>;
  sendMessage(sessionId: string, input: { text: string; idempotencyKey: string }): Promise<void>;
  listMessages(
    sessionId: string,
    cursor?: string
  ): Promise<{
    items: Array<{ id: string; role: string; text: string; createdAt: string }>;
    nextCursor: string | null;
  }>;
  listObservations(
    sessionId: string,
    cursor?: string
  ): Promise<{
    items: Array<{ id: string; kind: string; text: string; createdAt: string }>;
    nextCursor: string | null;
  }>;
  runTurn(sessionId: string, input: { text: string; idempotencyKey: string }): Promise<{ runId: string }>;
  pause(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  listPendingApprovals(
    projectId: string,
    sessionId?: string
  ): Promise<Array<{ id: string; sessionId: string; summary: string }>>;
  resolveApproval(approvalId: string, decision: 'approved' | 'denied'): Promise<void>;
}

export interface ProjectExperienceEvent {
  id: string;
  projectId: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ExperienceWorkerScheduler {
  schedule(projectId: string, input: { key: string; runAt: string }): Promise<void>;
  cancel(projectId: string, key: string): Promise<void>;
}

export interface ExperienceWorker {
  experienceId: string;
  onProjectStart(projectId: string, context: WorkspaceExperienceApiContext): Promise<void>;
  onEvent(event: ProjectExperienceEvent, context: WorkspaceExperienceApiContext): Promise<void>;
  onWake(input: { projectId: string; key: string; now: string }, context: WorkspaceExperienceApiContext): Promise<void>;
}

/** Authenticated, pack-scoped host capabilities passed only at an Experience API/worker boundary. */
export interface WorkspaceExperienceApiContext {
  atomPackId: string;
  principalId: string;
  experienceId: string;
  experienceState: ExperienceStateStore;
  projectSessions: ProjectSessionOperations;
  workerScheduler: ExperienceWorkerScheduler;
}

export type { WorkspaceExperiencePermission };

export type WorkspaceExperienceApiHandler = (
  request: Request,
  context: WorkspaceExperienceApiContext
) => Response | Promise<Response>;

export interface WorkspaceExperienceApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  handle: WorkspaceExperienceApiHandler;
}

export interface WorkspaceExperienceApi {
  experienceId: string;
  routes: WorkspaceExperienceApiRoute[];
}

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
  /** Register a native coding-CLI agent adapter (Codex, Claude Code, …). The daemon collects them
   *  into the external agent registry keyed by provider and owns the process/pty/socket lifecycle. */
  registerAgentAdapter(adapter: ExternalAgentProviderAdapter): void;
  /** Register an OS/remote sandbox launcher. The daemon collects launchers into a registry and
   *  selects one per platform at boot — the LLM-facing tools (code_execute/…) are unchanged. */
  registerSandbox(launcher: SandboxLauncher): void;
  registerWorkspaceExperience(experience: WorkspaceExperienceDefinition): void;
  registerWorkspaceExperienceApi(api: WorkspaceExperienceApi): void;
  registerExperienceWorker(worker: ExperienceWorker): void;
  /** Request bounded, host-rendered user input. The host owns presentation, routing, and lifecycle. */
  requestInteraction(request: InteractionRequest): Promise<InteractionResult>;
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
  /** Optional: hosts that don't support agent adapters omit it; registration then throws. */
  registerAgentAdapter?(adapter: ExternalAgentProviderAdapter): void;
  /** Optional: hosts that don't support sandbox launchers omit it; a sandbox registration then throws. */
  registerSandbox?(launcher: SandboxLauncher): void;
  /** Optional: hosts that don't support workspace experiences omit it; registration then throws. */
  registerWorkspaceExperience?(experience: WorkspaceExperienceDefinition): void;
  /** Optional: hosts that don't support workspace experience APIs omit it; registration then throws. */
  registerWorkspaceExperienceApi?(api: WorkspaceExperienceApi): void;
  /** Optional: hosts without background Experience workers reject registration. */
  registerExperienceWorker?(worker: ExperienceWorker): void;
  /** Optional host interaction bridge. The loader supplies the trusted, bound atom-pack identity. */
  requestInteraction?(atomPackId: string, request: InteractionRequest): Promise<InteractionResult>;
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
  agentAdapters?: ExternalAgentProviderAdapter[];
  sandboxes?: SandboxLauncher[];
  workspaceExperienceApis?: WorkspaceExperienceApi[];
  workspaceExperiences?: WorkspaceExperienceDefinition[];
  experienceWorkers?: ExperienceWorker[];
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
      for (const adapter of spec.agentAdapters ?? []) ctx.registerAgentAdapter(adapter);
      for (const sandbox of spec.sandboxes ?? []) ctx.registerSandbox(sandbox);
      for (const experience of spec.workspaceExperiences ?? []) ctx.registerWorkspaceExperience(experience);
      for (const api of spec.workspaceExperienceApis ?? []) ctx.registerWorkspaceExperienceApi(api);
      for (const worker of spec.experienceWorkers ?? []) ctx.registerExperienceWorker(worker);
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
  opts: { grantedAtoms?: readonly Atom[]; atomPackId?: string } = {}
): Promise<void> {
  const declared = new Set<Atom>(opts.grantedAtoms ?? pack.manifest.atoms);
  const name = pack.manifest.name;
  const atomPackId = opts.atomPackId ?? name;
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
    registerAgentAdapter: (a) => {
      gate('agent-adapter');
      if (!host.registerAgentAdapter) throw new Error(`host does not accept agent adapters (atom pack "${name}")`);
      host.registerAgentAdapter(a);
    },
    registerSandbox: (s) => {
      gate('sandbox');
      if (!host.registerSandbox) throw new Error(`host does not accept sandbox launchers (atom pack "${name}")`);
      host.registerSandbox(s);
    },
    registerWorkspaceExperience: (experience) => {
      gate('workspace-experience');
      if (!host.registerWorkspaceExperience) {
        throw new Error(`host does not accept workspace experiences (atom pack "${name}")`);
      }
      host.registerWorkspaceExperience(experience);
    },
    registerWorkspaceExperienceApi: (api) => {
      gate('workspace-experience');
      if (!host.registerWorkspaceExperienceApi) {
        throw new Error(`host does not accept workspace experience APIs (atom pack "${name}")`);
      }
      host.registerWorkspaceExperienceApi(api);
    },
    registerExperienceWorker: (worker) => {
      gate('workspace-experience');
      if (!host.registerExperienceWorker) {
        throw new Error(`host does not accept experience workers (atom pack "${name}")`);
      }
      host.registerExperienceWorker(worker);
    },
    requestInteraction: (request) => {
      if (!host.requestInteraction) {
        return Promise.resolve({ status: 'cancelled', reason: 'unavailable' });
      }
      return host.requestInteraction(atomPackId, request);
    },
    log: host.log ?? (() => {})
  };
  await pack.register(ctx);
}
