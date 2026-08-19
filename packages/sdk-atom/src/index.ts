// Deferred: the gate() hook that routes high-risk tool calls through human approval
// arrives with the oversight phase.

import type { LocalePack, Translate } from '@monad/i18n';
import type {
  AtomKind,
  AtomPackManifestWire,
  ChannelCapabilities,
  ChannelEnvVar,
  ChannelIcon,
  ChannelInbound,
  ChannelManifest,
  ChannelType,
  CommandArg,
  CommandItem,
  CommandItemType,
  CommandSource,
  CommandSubcommand,
  EventType,
  GenerationParams,
  HookEvent,
  HookInput,
  HookOutput,
  InteractionRequest,
  InteractionResult,
  MeshRawEventPage,
  MeshRawEventRecord,
  MessageTypeDescriptor,
  ModelInfo,
  ModelKind,
  ModelModalities,
  ModelPrice,
  ModelProviderDescriptor,
  ResourceScope,
  SessionMemberBinding,
  WorkplaceExperienceDefinition,
  WorkplaceExperienceEntry,
  WorkplaceExperienceHostApi,
  WorkplaceExperiencePermission,
  WorkplaceProjectMemberTemplate
} from '@monad/protocol';
import type {
  AdapterMigration,
  MeshAgentAcpDelivery,
  MeshAgentArgumentSupport,
  MeshAgentArgumentSupportProbe,
  MeshAgentAuthStatusProbe,
  MeshAgentDiscoveredAgent,
  MeshAgentDiscoveryProbe,
  MeshAgentEnvironmentPolicy,
  MeshAgentErrorCode,
  MeshAgentEventPageRequest,
  MeshAgentEventPageResult,
  MeshAgentEventSource,
  MeshAgentImmutableInstructions,
  MeshAgentLaunchSpec,
  MeshAgentManagedEnvContext,
  MeshAgentManagedRuntime,
  MeshAgentManagedRuntimeContext,
  MeshAgentModelOption,
  MeshAgentModelOptionsProbe,
  MeshAgentObservationActivity,
  MeshAgentObservationJsonRecordEntry,
  MeshAgentObservationMessageGroupProjector,
  MeshAgentObservationProjector,
  MeshAgentObservationRecordProjector,
  MeshAgentObservationRuntime,
  MeshAgentObservationToolRun,
  MeshAgentObservationUsageProjector,
  MeshAgentOutputEvent,
  MeshAgentProjectionPage,
  MeshAgentProviderAdapter,
  MeshAgentProviderEventContext,
  MeshAgentProviderEventPageContext,
  MeshAgentProviderEventPageRequestContext,
  MeshAgentProviderSessionLifecycleContext,
  MeshAgentProviderSessionUsageContext,
  MeshAgentSessionRuntimeContext,
  MeshAgentSessionStartInput,
  MeshAgentSessionUsageSource,
  MeshAgentSettingsImport,
  MeshAgentStartPreflight,
  MeshAgentUsageProbe
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
  ChannelNativeCommand,
  ChannelRuntimeStatus,
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
  CommandProjectInfo,
  CommandProjectNavigation,
  CommandProjectSelection,
  CommandResult,
  CommandRunContext,
  CommandSessionInfo,
  CommandSubcommandDefinition,
  CompactSummary,
  ConsolidateMemorySummary,
  ConsolidateSummary,
  ContradictionCheckSummary
} from './command.ts';
import type { HookDefinition, HookHandler } from './hook.ts';
import type {
  DriverContext,
  DriverReady,
  EncodedTurnInput,
  MeshAgentEventSink,
  MeshAgentProcessLaunchPlan,
  MeshAgentProviderDriver,
  MeshAgentSessionEvent,
  PerTurnProviderDriver,
  PerTurnSessionEventPlan,
  ProviderDriverBase,
  ProviderDriverControls,
  ReconnectPolicy,
  ResidentProviderDriver,
  ResidentSessionEventPlan,
  SessionEventChannel,
  SessionEventChannelContext,
  SessionEventChannelPlan,
  SessionEventPacket,
  SessionEventRuntimeDefinition,
  SessionEventRuntimePlan,
  StartupPolicy,
  SuspendPolicy,
  TurnChannelContext,
  TurnProcessResult
} from './mesh-agent-session-runtime.ts';
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
  SandboxExit,
  SandboxLauncher,
  SandboxLauncherDescriptor,
  SandboxPolicy,
  SandboxProcess,
  SandboxRunLimits,
  SandboxSettingsSchema,
  SandboxSpawnOptions,
  SandboxStdin,
  SandboxTerminal,
  SandboxTerminalOptions,
  SandboxViolation
} from './sandbox.ts';

import sdkPackage from '../package.json' with { type: 'json' };
import { MeshAgentError, meshAgentOutputEventSchema } from './agent-adapter.ts';
import { canonicalJson, contentHash, toFallbackAgentObservationEvent } from './agent-observation.ts';
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
  ChannelAdapter,
  ChannelAdapterFactory,
  ChannelAtomConfig,
  ChannelCapabilities,
  ChannelContext,
  ChannelDefinition,
  ChannelEnvVar,
  ChannelHarnessOptions,
  ChannelIcon,
  ChannelInbound,
  ChannelLog,
  ChannelManifest,
  ChannelNativeCommand,
  ChannelRuntimeStatus,
  ChannelTestHarness,
  ChannelType,
  CommandArg,
  CommandDefinition,
  CommandEffect,
  CommandItem,
  CommandItemType,
  CommandLog,
  CommandModelInfo,
  CommandProjectInfo,
  CommandProjectNavigation,
  CommandProjectSelection,
  CommandResult,
  CommandRunContext,
  CommandSessionInfo,
  CommandSource,
  CommandSubcommand,
  CommandSubcommandDefinition,
  CompactSummary,
  ConsolidateMemorySummary,
  ConsolidateSummary,
  ContradictionCheckSummary,
  DriverContext,
  DriverReady,
  EmbedCall,
  EmbedResult,
  EncodedTurnInput,
  GenerationParams,
  HookDefinition,
  HookEvent,
  HookHandler,
  HookInput,
  HookOutput,
  ImageCall,
  ImageResult,
  LocalePack,
  MeshAgentAcpDelivery,
  MeshAgentArgumentSupport,
  MeshAgentArgumentSupportProbe,
  MeshAgentAuthStatusProbe,
  MeshAgentDiscoveredAgent,
  MeshAgentDiscoveryProbe,
  MeshAgentEnvironmentPolicy,
  MeshAgentErrorCode,
  MeshAgentEventPageRequest,
  MeshAgentEventPageResult,
  MeshAgentEventSink,
  MeshAgentEventSource,
  MeshAgentImmutableInstructions,
  MeshAgentLaunchSpec,
  MeshAgentManagedEnvContext,
  MeshAgentManagedRuntime,
  MeshAgentManagedRuntimeContext,
  MeshAgentModelOption,
  MeshAgentModelOptionsProbe,
  MeshAgentObservationActivity,
  MeshAgentObservationJsonRecordEntry,
  MeshAgentObservationMessageGroupProjector,
  MeshAgentObservationProjector,
  MeshAgentObservationRecordProjector,
  MeshAgentObservationRuntime,
  MeshAgentObservationToolRun,
  MeshAgentObservationUsageProjector,
  MeshAgentOutputEvent,
  MeshAgentProcessLaunchPlan,
  MeshAgentProjectionPage,
  MeshAgentProviderAdapter,
  MeshAgentProviderDriver,
  MeshAgentProviderEventContext,
  MeshAgentProviderEventPageContext,
  MeshAgentProviderEventPageRequestContext,
  MeshAgentProviderSessionLifecycleContext,
  MeshAgentProviderSessionUsageContext,
  MeshAgentSessionEvent,
  MeshAgentSessionRuntimeContext,
  MeshAgentSessionStartInput,
  MeshAgentSessionUsageSource,
  MeshAgentSettingsImport,
  MeshAgentStartPreflight,
  MeshAgentUsageProbe,
  MeshRawEventPage,
  MeshRawEventRecord,
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
  PerTurnProviderDriver,
  PerTurnSessionEventPlan,
  ProviderCredential,
  ProviderDriverBase,
  ProviderDriverControls,
  ProviderToolHint,
  ReconnectPolicy,
  RerankCall,
  RerankResult,
  ResidentProviderDriver,
  ResidentSessionEventPlan,
  ResolvedProviderConfig,
  ResourceScope,
  SandboxBackendRef,
  SandboxEnforcement,
  SandboxExit,
  SandboxLauncher,
  SandboxLauncherDescriptor,
  SandboxPolicy,
  SandboxProcess,
  SandboxRunLimits,
  SandboxSettingsSchema,
  SandboxSpawnOptions,
  SandboxStdin,
  SandboxTerminal,
  SandboxTerminalOptions,
  SandboxViolation,
  SendOptions,
  SentMessage,
  SessionEventChannel,
  SessionEventChannelContext,
  SessionEventChannelPlan,
  SessionEventPacket,
  SessionEventRuntimeDefinition,
  SessionEventRuntimePlan,
  SpeechCall,
  SpeechResult,
  StartupPolicy,
  SuspendPolicy,
  ToolCall,
  ToolSpec,
  TranscriptionCall,
  TranscriptionResult,
  Translate,
  TurnChannelContext,
  TurnProcessResult,
  UsageLimits,
  UsageSnapshot,
  VideoCall,
  VideoResult,
  WorkplaceExperienceDefinition,
  WorkplaceExperienceEntry,
  WorkplaceExperienceHostApi
};

export {
  assertChannelInbound,
  canonicalJson,
  configureSandboxCredential,
  contentHash,
  createChannelTestHarness,
  defaultBinProbes,
  defineChannel,
  defineCommand,
  defineLocalLauncher,
  defineProvider,
  extractCacheWrite,
  extractProviderCost,
  MeshAgentError,
  meshAgentOutputEventSchema,
  noneLauncher,
  parseChannelManifest,
  resolveBinary,
  sandboxBackendRefSchema,
  sandboxCredential,
  sandboxLauncherDescriptorSchema,
  sandboxSettingsSchema,
  toFallbackAgentObservationEvent,
  usageFromProviderMetadataJson
};

/** The installed SDK package version. Atom packs declare a semver range that the host checks at load. */
export const SDK_VERSION = sdkPackage.version;

/** Default compatibility range for atom packs authored against this SDK release. */
export const SDK_COMPATIBILITY_RANGE = `^${SDK_VERSION}`;

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

/** Opaque, pack-private state exposed to a workplace experience API or worker.
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
  compareAndDelete(input: {
    projectId: string;
    key: string;
    expectedVersion: number;
    event: unknown;
  }): Promise<boolean>;
}

export interface ProjectSessionRunSnapshot {
  id: string;
  state: 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
}

export interface ProjectSessionArtifact {
  messageId: string;
  memberId?: string;
  name?: string;
  path: string;
  mime?: string;
  createdAt: string;
}

/** Generic project-session operations available to a workplace experience.
 * These deliberately contain no product-specific task or proposal concepts. */
export interface ProjectSessionOperations {
  list(projectId: string): Promise<Array<{ id: string; title: string; state: string }>>;
  create(
    projectId: string,
    input: {
      title: string;
      cwd?: string;
      idempotencyKey: string;
    }
  ): Promise<{ id: string }>;
  sendMessage(sessionId: string, input: { text: string; idempotencyKey: string }): Promise<void>;
  listMessages(
    sessionId: string,
    cursor?: string
  ): Promise<{
    items: Array<{ id: string; role: string; text: string; createdAt: string }>;
    nextCursor: string | null;
  }>;
  listArtifacts?(sessionId: string): Promise<ProjectSessionArtifact[]>;
  listObservations(
    sessionId: string,
    cursor?: string
  ): Promise<{
    items: Array<{ id: string; kind: string; text: string; createdAt: string }>;
    nextCursor: string | null;
  }>;
  runTurn(sessionId: string, input: { text: string; idempotencyKey: string }): Promise<{ runId: string }>;
  getRun(sessionId: string, runId: string): Promise<ProjectSessionRunSnapshot | null>;
  pause(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  listPendingApprovals(
    projectId: string,
    sessionId?: string
  ): Promise<Array<{ id: string; sessionId: string; summary: string }>>;
  resolveApproval(approvalId: string, decision: 'approved' | 'denied'): Promise<void>;
}

export interface ProjectMemberOperations {
  listTemplates(projectId: string): Promise<ProjectMemberTemplateView[]>;
  listSessionMembers(sessionId: string): Promise<SessionMemberBinding[]>;
  inviteSessionMember(sessionId: string, templateId: string): Promise<SessionMemberBinding>;
  removeSessionMember(sessionId: string, memberId: string): Promise<void>;
}

export type ProjectMemberTemplateView = WorkplaceProjectMemberTemplate & {
  presentation?: {
    avatarUrl?: string;
    icon?: string;
    provider?: string;
  };
};

export interface ProjectExperienceEvent {
  id: string;
  projectId: string;
  sessionId: string;
  type: EventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ExperienceWorkerScheduler {
  schedule(projectId: string, input: { key: string; runAt: string }): Promise<void>;
  cancel(projectId: string, key: string): Promise<void>;
}

export interface ExperienceWorker {
  experienceId: string;
  subscriptions: readonly EventType[];
  onProjectStart(projectId: string, context: WorkplaceExperienceApiContext): Promise<void>;
  onEvent(event: ProjectExperienceEvent, context: WorkplaceExperienceApiContext): Promise<void>;
  onWake(input: { projectId: string; key: string; now: string }, context: WorkplaceExperienceApiContext): Promise<void>;
}

/** Authenticated, pack-scoped host capabilities passed only at an Experience API/worker boundary. */
export interface WorkplaceExperienceApiContext {
  atomPackId: string;
  experienceId: string;
  experienceState: ExperienceStateStore;
  projectSessions: ProjectSessionOperations;
  projectMembers: ProjectMemberOperations;
  requestInteraction(request: InteractionRequest): Promise<InteractionResult>;
  workerScheduler: ExperienceWorkerScheduler;
}

export type { WorkplaceExperiencePermission };

export type WorkplaceExperienceApiHandler = (
  request: Request,
  context: WorkplaceExperienceApiContext
) => Response | Promise<Response>;

export interface WorkplaceExperienceApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  handle: WorkplaceExperienceApiHandler;
}

export interface WorkplaceExperienceApi {
  experienceId: string;
  routes: WorkplaceExperienceApiRoute[];
}

/** The host facade passed to register(). Every registerX is gated by manifest.atoms.
 *  skill/mcp/locale are file-based and do NOT appear here — they are installed at the
 *  atom-pack-manager level and discovered from disk at daemon startup.
 *  Tools are NOT an atom kind: they are always first-party and built into the daemon, so atom
 *  packs cannot register them. */
export interface AtomPackContext {
  registerChannel(channel: ChannelDefinition): void;
  registerCommand(command: unknown): void;
  /** Register a custom message type. The host namespaces it under the atom pack id, so the rendered
   * wire `type` becomes `<atomPackId>:<descriptor.type>`. */
  registerMessageType(descriptor: MessageTypeDescriptor): void;
  registerProvider(provider: ModelProvider): void;
  registerHook(hook: HookDefinition): void;
  /** Register a native coding-CLI agent adapter. The daemon collects them
   *  into the MeshAgent registry keyed by provider and owns the process/pty/socket lifecycle. */
  registerAgentAdapter(adapter: MeshAgentProviderAdapter): void;
  /** Register an OS/remote sandbox launcher. The daemon collects launchers into a registry and
   *  selects one per platform at boot — the LLM-facing tools (code_execute/…) are unchanged. */
  registerSandbox(launcher: SandboxLauncher): void;
  registerWorkplaceExperience(experience: WorkplaceExperienceDefinition): void;
  registerWorkplaceExperienceApi(api: WorkplaceExperienceApi): void;
  registerExperienceWorker(worker: ExperienceWorker): void;
  /** Request bounded, host-rendered user input. The host owns presentation, routing, and lifecycle. */
  requestInteraction(request: InteractionRequest): Promise<InteractionResult>;
  log: AtomPackLog;
}

export interface ManifestAtomPack {
  manifest: AtomPackManifest;
  register(ctx: AtomPackContext): void | Promise<void>;
  /**
   * Release anything `register` acquired that the host cannot reclaim on its own: timers, sockets,
   * watchers, child processes. The host calls it once when the pack stops being loaded — disabled,
   * uninstalled, or gone from a rediscovery sweep — after in-flight work has drained.
   *
   * Registrations themselves are not your concern: the host drops those wholesale. Implement this
   * only if `register` started something. It must be idempotent and must not throw; a failure is
   * logged and does not block the sweep.
   */
  deactivate?(): void | Promise<void>;
}

/** What the daemon implements to receive gated registrations. */
export interface ManifestAtomPackHost {
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
  registerAgentAdapter?(adapter: MeshAgentProviderAdapter): void;
  /** Optional: hosts that don't support sandbox launchers omit it; a sandbox registration then throws. */
  registerSandbox?(launcher: SandboxLauncher): void;
  /** Optional: hosts that don't support workplace experiences omit it; registration then throws. */
  registerWorkplaceExperience?(experience: WorkplaceExperienceDefinition): void;
  /** Optional: hosts that don't support workplace experience APIs omit it; registration then throws. */
  registerWorkplaceExperienceApi?(api: WorkplaceExperienceApi): void;
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
  channels?: ChannelDefinition[];
  commands?: unknown[];
  messageTypes?: MessageTypeDescriptor[];
  providers?: ModelProvider[];
  hooks?: HookDefinition[];
  agentAdapters?: MeshAgentProviderAdapter[];
  sandboxes?: SandboxLauncher[];
  workplaceExperienceApis?: WorkplaceExperienceApi[];
  workplaceExperiences?: WorkplaceExperienceDefinition[];
  experienceWorkers?: ExperienceWorker[];
  deactivate?: () => void | Promise<void>;
}): ManifestAtomPack {
  return {
    manifest: spec.manifest,
    ...(spec.deactivate ? { deactivate: spec.deactivate } : {}),
    register(ctx: AtomPackContext) {
      for (const channel of spec.channels ?? []) ctx.registerChannel(channel);
      for (const command of spec.commands ?? []) ctx.registerCommand(command);
      for (const mt of spec.messageTypes ?? []) ctx.registerMessageType(mt);
      for (const provider of spec.providers ?? []) ctx.registerProvider(provider);
      for (const hook of spec.hooks ?? []) ctx.registerHook(hook);
      for (const adapter of spec.agentAdapters ?? []) ctx.registerAgentAdapter(adapter);
      for (const sandbox of spec.sandboxes ?? []) ctx.registerSandbox(sandbox);
      for (const experience of spec.workplaceExperiences ?? []) ctx.registerWorkplaceExperience(experience);
      for (const api of spec.workplaceExperienceApis ?? []) ctx.registerWorkplaceExperienceApi(api);
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
      if (!host.registerProvider) throw new Error(`host does not accept model providers (Atom Pack "${name}")`);
      host.registerProvider(p);
    },
    registerHook: (h) => {
      gate('hook');
      if (!host.registerHook) throw new Error(`host does not accept lifecycle hooks (Atom Pack "${name}")`);
      host.registerHook(h);
    },
    registerAgentAdapter: (a) => {
      gate('agent-adapter');
      if (!host.registerAgentAdapter) throw new Error(`host does not accept agent adapters (Atom Pack "${name}")`);
      host.registerAgentAdapter(a);
    },
    registerSandbox: (s) => {
      gate('sandbox');
      if (!host.registerSandbox) throw new Error(`host does not accept sandbox launchers (Atom Pack "${name}")`);
      host.registerSandbox(s);
    },
    registerWorkplaceExperience: (experience) => {
      gate('workplace-experience');
      if (!host.registerWorkplaceExperience) {
        throw new Error(`host does not accept workplace experiences (Atom Pack "${name}")`);
      }
      host.registerWorkplaceExperience(experience);
    },
    registerWorkplaceExperienceApi: (api) => {
      gate('workplace-experience');
      if (!host.registerWorkplaceExperienceApi) {
        throw new Error(`host does not accept workplace experience APIs (Atom Pack "${name}")`);
      }
      host.registerWorkplaceExperienceApi(api);
    },
    registerExperienceWorker: (worker) => {
      gate('workplace-experience');
      if (!host.registerExperienceWorker) {
        throw new Error(`host does not accept experience workers (Atom Pack "${name}")`);
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

export type { LiveProjectionAdapter, LiveProjectionRow } from './live-projection.ts';

export {
  advanceConvenienceRows,
  createConvenienceLiveProjector,
  projectConvenienceRows,
  toConvenienceEvents
} from './live-projection.ts';
