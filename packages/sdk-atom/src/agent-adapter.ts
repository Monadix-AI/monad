import type {
  AdapterMigrationApplyRequest,
  AdapterMigrationApplyResult,
  AdapterMigrationCandidate,
  AdapterMigrationPreview,
  AdapterMigrationPreviewRequest,
  AgentObservationCard,
  AgentObservationEvent,
  MeshAgentAuthState,
  MeshAgentObservationEvent,
  MeshAgentPresetView,
  MeshAgentProductIcon,
  MeshAgentProvider,
  MeshAgentSetting,
  MeshAgentTurnInput,
  MeshAgentUsageLimitMeter,
  MeshAgentUsageRecord,
  MeshAgentView,
  MeshRawEventPage
} from '@monad/protocol';
import type { BinProbes } from './bin-probes.ts';
import type { SessionEventRuntimeDefinition } from './mesh-agent-session-runtime.ts';

import { z } from 'zod';

export type MeshAgentErrorCode =
  | 'provider_not_installed'
  | 'provider_not_logged_in'
  | 'unsupported_capability'
  | 'provider_timeout'
  | 'provider_protocol_error';

export class MeshAgentError extends Error {
  constructor(
    readonly code: MeshAgentErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'MeshAgentError';
  }
}

export interface MeshAgentLaunchSpec {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
}

export type MeshAgentStartPreflight =
  | {
      state: 'ready';
      agentName: string;
      provider: MeshAgentProvider;
      checkedAt: string;
      providerSessionRef?: string;
    }
  | {
      state: 'not_authenticated';
      agentName: string;
      provider: MeshAgentProvider;
      checkedAt: string;
      action: 'reconnect_in_studio';
      reason: string;
    }
  | {
      state: 'unavailable';
      agentName: string;
      provider: MeshAgentProvider;
      checkedAt: string;
      reason: string;
    }
  | {
      state: 'unknown';
      agentName: string;
      provider: MeshAgentProvider;
      checkedAt: string;
      action: 'manual_check_in_studio';
      reason: string;
    };

export interface MeshAgentSessionRuntimeContext {
  workingPath: string;
  extraWorkingPaths?: string[];
  providerSessionRef?: string;
  startInput?: MeshAgentSessionStartInput;
  skipProviderApprovals?: boolean;
  mcpConfigArgs?: string[];
  env?: Record<string, string>;
  modelName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
}

export interface MeshAgentImmutableInstructions {
  text: string;
  file: string;
}

export interface MeshAgentSessionStartInput {
  immutableInstructions?: MeshAgentImmutableInstructions;
  initialTurn: MeshAgentTurnInput;
}

export interface MeshAgentOutputEvent {
  type:
    | 'approval_requested'
    | 'approval_resolved'
    | 'agent_message'
    | 'connection_required'
    | 'event_page'
    | 'provider_error'
    | 'session_ref'
    | 'tool_call'
    | 'tool_result'
    | 'web_search_result';
  payload: Record<string, unknown>;
}

const requestIdSchema = z.union([z.string().min(1), z.number()]);
const meshAgentOutputPayloadBase = z.object({}).catchall(z.unknown());

export const meshAgentOutputEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session_ref'),
    payload: meshAgentOutputPayloadBase.extend({
      providerSessionRef: z.string().min(1)
    })
  }),
  z.object({
    type: z.literal('agent_message'),
    payload: meshAgentOutputPayloadBase.extend({
      text: z.string(),
      final: z.boolean().optional()
    })
  }),
  z.object({
    type: z.literal('tool_call'),
    payload: meshAgentOutputPayloadBase.extend({
      callId: z.union([z.string().min(1), z.number()]).optional(),
      tool: z.string().min(1).optional(),
      input: z.unknown().optional()
    })
  }),
  z.object({
    type: z.literal('tool_result'),
    payload: meshAgentOutputPayloadBase.extend({
      callId: z.union([z.string().min(1), z.number()]).optional(),
      output: z.unknown().optional()
    })
  }),
  z.object({
    type: z.literal('web_search_result'),
    payload: meshAgentOutputPayloadBase.extend({
      callId: z.union([z.string().min(1), z.number()]).optional(),
      status: z.string().optional()
    })
  }),
  z.object({
    type: z.literal('connection_required'),
    payload: meshAgentOutputPayloadBase.extend({
      code: z.string().min(1).optional(),
      reason: z.string().min(1)
    })
  }),
  z.object({
    type: z.literal('provider_error'),
    payload: meshAgentOutputPayloadBase.extend({
      responseId: z.union([z.string().min(1), z.number()]).optional(),
      code: z.union([z.string().min(1), z.number()]).optional(),
      message: z.string().min(1)
    })
  }),
  z.object({
    type: z.literal('event_page'),
    payload: meshAgentOutputPayloadBase.extend({
      responseId: z.union([z.string().min(1), z.number()]),
      items: z.array(z.unknown()),
      nextCursor: z.string().nullable(),
      backwardsCursor: z.string().nullable()
    })
  }),
  z.object({
    type: z.literal('approval_requested'),
    payload: meshAgentOutputPayloadBase.extend({
      requestId: requestIdSchema,
      kind: z.string().min(1)
    })
  }),
  z.object({
    type: z.literal('approval_resolved'),
    payload: meshAgentOutputPayloadBase.extend({
      requestId: requestIdSchema
    })
  })
]);

export interface MeshAgentProviderEventContext {
  providerSessionRef: string;
  workingPath: string;
}

export interface MeshAgentProviderEventPageContext extends MeshAgentProviderEventContext {
  /** Raw provider records to reshape into the live-JSONL-mimicking output string — not the daemon's
   *  wire response shape (that carries normalized `events`, not raw items). */
  page: { items: unknown[]; nextCursor?: string };
}

export interface MeshAgentProviderEventPageRequestContext extends MeshAgentProviderEventContext {
  request: {
    before?: string;
    limit: number;
    sortDirection: 'asc' | 'desc';
    itemsView: 'full';
  };
}

export interface MeshAgentEventPageRequest {
  view: 'raw' | 'convenience';
  before?: string;
  limit: number;
}

export interface MeshAgentProjectionPage {
  events: MeshAgentObservationEvent[];
  nextCursor?: string;
}

export type MeshAgentEventPageResult =
  | ({ state: 'available'; view: 'convenience' } & MeshAgentProjectionPage)
  | ({ state: 'available'; view: 'raw' } & MeshRawEventPage)
  | { state: 'unavailable'; reason: 'unsupported' | 'not-found' | 'temporary' };

export interface MeshAgentEventSource {
  projectLive(args: { id: string; output: string; mode?: 'live' | 'events' }): MeshAgentProjectionPage;
  createLiveProjector?(args: { id: string }): {
    advance(delta: string): MeshAgentProjectionPage;
  };
  readPage?(
    context: MeshAgentProviderEventContext,
    request: MeshAgentEventPageRequest
  ): Promise<MeshAgentEventPageResult>;
}

export interface MeshAgentAuthStatusProbe {
  launch: MeshAgentLaunchSpec;
  parse(output: string, exitCode: number | null): MeshAgentAuthState;
}

export interface MeshAgentModelOption {
  value: string;
  displayName?: string;
}

export interface MeshAgentModelOptionsProbe {
  launch: MeshAgentLaunchSpec;
  parse(output: string, exitCode: number | null): MeshAgentModelOption[];
}

export interface MeshAgentUsageProbe {
  launch: MeshAgentLaunchSpec;
  parse(output: string, exitCode: number | null): MeshAgentUsageRecord[];
}

export type MeshAgentObservationJsonRecordEntry = {
  record: Record<string, unknown>;
  raw: string;
};

export type MeshAgentObservationMessageGroupProjector = {
  append(group: unknown, entry: MeshAgentObservationJsonRecordEntry): void;
  create(record: Record<string, unknown>): { key: string; state: unknown } | undefined;
  render(id: string, group: unknown): MeshAgentObservationEvent[];
};

export type MeshAgentObservationRecordProjector = {
  parse(args: {
    id: string;
    provider?: string;
    record: Record<string, unknown>;
    recordIndex: number;
  }): MeshAgentObservationEvent[];
  supports?(record: Record<string, unknown>): boolean;
};

export type MeshAgentObservationUsageProjector = {
  usageRecords?(record: Record<string, unknown>): MeshAgentUsageRecord[];
};

/** Provider-agnostic classification of a projected observation event. The adapter (which owns its
 *  provider's event vocabulary) maps each event it produces to one of these kinds; consumers derive
 *  turn/generating state and the UI activity phase from the kind, never from a provider event string.
 *  `turn-end` marks a terminal record (result / turn completed / error). */
export type MeshAgentObservationActivity =
  | 'thinking'
  | 'message'
  | 'tool-call'
  | 'tool-result'
  | 'user'
  | 'system'
  // A transient in-flight status ping (e.g. a thread going working/idle mid-turn), distinct from
  // `system`'s one-time session notices (login, init, rate limits) — never worth its own UI card.
  | 'status'
  | 'turn-end';

export type MeshAgentObservationProjector = MeshAgentObservationUsageProjector & {
  identity?(event: MeshAgentObservationEvent): string | undefined;
  checkpoint?(event: MeshAgentObservationEvent): string | undefined;
  eventEntries?(entries: MeshAgentObservationJsonRecordEntry[]): MeshAgentObservationJsonRecordEntry[];
  messageGroup?: MeshAgentObservationMessageGroupProjector;
  recordProjectors: MeshAgentObservationRecordProjector[];
  /** Classify one event this adapter produced into a provider-agnostic activity kind. Returning
   *  `undefined` means "no signal" (the event doesn't affect generating/phase). Consumers fall back
   *  to a role-only heuristic when an adapter omits this. */
  classifyActivity?(event: MeshAgentObservationEvent): MeshAgentObservationActivity | undefined;
  /** Whether an event is a partial streaming fragment (a token delta) rather than a settled item.
   *  Consumers use it to merge adjacent fragments and to drive streaming affordances, without knowing
   *  this provider's delta event names. */
  isStreamingFragment?(event: MeshAgentObservationEvent): boolean;
  mergeStreamingRun?(events: MeshAgentObservationEvent[]): MeshAgentObservationEvent | undefined;
};

export interface MeshAgentObservationRuntime {
  toAgentObservationEvent(event: MeshAgentObservationEvent): AgentObservationEvent | null;
  toAgentObservationCards(events: readonly AgentObservationEvent[], provider: string): AgentObservationCard[];
  structuredEvents(args: {
    id: string;
    output?: string;
    observedAt?: string;
    mode?: 'events' | 'live';
  }): MeshAgentObservationEvent[] | undefined;
  eventsAreGenerating(events: readonly MeshAgentObservationEvent[]): boolean;
  usageLimitMeter(output?: string): MeshAgentUsageLimitMeter | null;
}

export interface MeshAgentArgumentSupport {
  flags: string[];
  reasoningEfforts: string[];
  speeds: string[];
  /** Reasoning efforts supported per model slug (e.g. codex reports these per model). Lets a picker
   *  offer only the efforts a selected model actually supports; `reasoningEfforts` is their union. */
  reasoningEffortsByModel?: Record<string, string[]>;
}

export interface MeshAgentArgumentSupportProbe {
  launch: MeshAgentLaunchSpec;
  parse(output: string, exitCode: number | null): MeshAgentArgumentSupport;
}

export interface MeshAgentManagedRuntimeContext {
  monadCliEntry: {
    command: string;
    args: string[];
  };
  env: Record<string, string>;
}

export interface MeshAgentManagedEnvContext {
  /** The managed agent's private workspace directory (already created on disk). A provider whose
   *  autopilot toggle has no CLI-flag equivalent writes its own
   *  config/state files here and points the child at them via env vars, rather than an argv flag. */
  workspace: string;
  /** The resolved `allowAutopilot` outcome for this launch: true → the provider should run unattended
   *  (skip its own approval prompts); false → it should prompt as normal so the daemon's approval
   *  channel (where supported) can project and resolve those requests. */
  skipProviderApprovals: boolean;
}

/** Provider-specific behavior for a *managed* project-agent runtime — an MeshAgent that monad spawns
 *  and supervises as a Workplace project member. Absent → the generic defaults apply, so the daemon's
 *  managed-runtime code stays provider-agnostic and reads intent from the adapter instead of branching
 *  on the provider id. */
export interface MeshAgentManagedRuntime {
  /** Env additions for the managed child. */
  env?(context: MeshAgentManagedEnvContext): Record<string, string>;
  /** CLI args wiring monad's managed MCP server into the provider. */
  mcpConfigArgs?(context: MeshAgentManagedRuntimeContext): string[];
  /** The provider mounts monad's managed MCP server as its project bridge — drives the MCP prompt
   *  template, the MCP-flavored join greeting, and the MCP tool-usage communication instructions. */
  usesManagedMcpBridge?: boolean;
}

export interface MeshAgentProviderSessionLifecycleContext {
  meshSessionId: string;
  transcriptTargetId: string;
  agentName: string;
  providerSessionRef: string;
  workingPath: string;
}

/** Child-process environment policy. `strip` names keys that must not reach the child whatever their
 *  source. Policies are unioned, never subtracted: an adapter or delivery can only add to the daemon's
 *  own invariants, so declaring one can never widen what a child inherits. */
export interface MeshAgentEnvironmentPolicy {
  strip?: string[];
}

/** ACP (Agent Client Protocol) delivery variant — the SAME agent launched as an external ACP
 *  sub-agent (an `npx` wrapper package bridging the agent's own SDK) instead of driven as a native
 *  CLI. Present only on agents that ship an ACP wrapper; the daemon's ACP
 *  delegation derives its invite preset + spawn command from this, while the agent's identity and
 *  install detection still come from `detect()` — one adapter, forked by delivery mode. */
export interface MeshAgentAcpDelivery {
  /** Spawn command for the ACP wrapper (e.g. `npx`). */
  command: string;
  /** Args for the ACP wrapper. */
  args: string[];
  /** Optional auth env forwarded to the wrapper as secret refs. */
  env?: Record<string, string>;
  /** Provider login roots that make the ACP wrapper usable even when the native binary probe misses. */
  loginDirectories?: string[];
  /** Environment policy applying only to this delivery, unioned with the adapter's own policy. */
  environment?: MeshAgentEnvironmentPolicy;
  /** Provider credential/config directories that must remain visible inside an OS sandbox. */
  credentialDirectories?: Array<{ path: string; env?: string }>;
  /** API-key environment variables to include in generic authentication recovery guidance. */
  authEnvironmentVariables?: string[];
}

export interface AdapterMigration {
  /** Probe adapter-owned default migration sources, returning only paths that currently exist. */
  detect(probes?: BinProbes): AdapterMigrationCandidate[];
  /** Whether an explicit path belongs to this provider. Used by generic `from:auto` hosts without
   *  teaching them provider filenames or config markers. */
  recognizes?(path: string): boolean | Promise<boolean>;
  /** Parse provider-specific settings into Monad's shared preview contract. */
  preview(request: AdapterMigrationPreviewRequest): AdapterMigrationPreview | Promise<AdapterMigrationPreview>;
  /** Optional adapter-side apply hook for out-of-process adapters. The daemon still owns Monad config
   *  writes for built-in migrations and uses this hook only when an adapter needs provider-owned apply. */
  apply?(request: AdapterMigrationApplyRequest): AdapterMigrationApplyResult | Promise<AdapterMigrationApplyResult>;
}
export type MeshAgentSettingsImport = AdapterMigration;

/** The authoring contract for an agent-adapter atom. Mesh session execution is exposed only through
 *  `createSessionRuntime`; authentication and read-only probes use separate command specs. */
export interface MeshAgentProviderAdapter {
  /** Environment policy shared by every delivery of this provider. */
  environment?: MeshAgentEnvironmentPolicy;
  /** Provider-specific managed project-agent runtime behavior; absent → generic defaults. */
  managedRuntime?: MeshAgentManagedRuntime;
  /** ACP delivery variant; absent → this agent has no ACP wrapper (MeshAgent delivery only). */
  acp?: MeshAgentAcpDelivery;
  /** Optional provider-specific migration surface. Current UI entry points may apply only a subset of
   *  categories (for example MeshAgents) even when the adapter previews broader settings. */
  settingsImport?: AdapterMigration;
  /** Optional provider-wire transcript projection into Monad protocol events. This is data-only:
   *  adapters may decode their own JSONL/history format, but must not return UI components, labels,
   *  cards, or view state. Experience surfaces consume only the resulting protocol events. */
  observation?: MeshAgentObservationProjector;
  /** Provider-neutral observation helpers composed by the atom pack alongside the provider projector. */
  observationRuntime?: MeshAgentObservationRuntime;
  /** Provider-owned live/history event acquisition and projection. Unrecognized provider records
   *  must survive as shared unknown envelopes rather than being dropped. */
  events: MeshAgentEventSource;
  /** Declarative operator settings for this adapter. The UI renders these controls dynamically; keys
   *  address fields on `MeshAgentView` so daemon launch behavior still reads the shared contract. */
  settings?(agent?: MeshAgentView): MeshAgentSetting[];
  provider: MeshAgentProvider;
  productIcon: MeshAgentProductIcon;
  /** Human display name — the single source the daemon/UI reads instead
   *  of mapping a provider id to a label. */
  label: string;
  detect(probes?: BinProbes): MeshAgentPresetView;
  listSupportedModels(agent?: MeshAgentView): string[];
  modelOptions?(agent: MeshAgentView): MeshAgentModelOptionsProbe;
  resolveCommand?(command: string, probes?: BinProbes): string | undefined;
  createSessionRuntime?(agent: MeshAgentView, context: MeshAgentSessionRuntimeContext): SessionEventRuntimeDefinition;
  archiveSession?(context: MeshAgentProviderSessionLifecycleContext): void | Promise<void>;
  deleteSession?(context: MeshAgentProviderSessionLifecycleContext): void | Promise<void>;
  /** Return the first provider-specific argv token that enables an unsafe/unattended mode. The daemon
   *  owns the `allowAutopilot` decision, while each adapter owns its CLI vocabulary. */
  unsafeArgument?(args: string[]): string | undefined;
  buildAuthLaunch(agent: MeshAgentView): MeshAgentLaunchSpec;
  buildAuthStatusLaunch(agent: MeshAgentView): MeshAgentLaunchSpec;
  authStatus(agent: MeshAgentView): MeshAgentAuthStatusProbe;
  argumentSupport?(agent: MeshAgentView): MeshAgentArgumentSupportProbe;
  usage?(agent: MeshAgentView): MeshAgentUsageProbe;
  parseAuthStatus(output: string, exitCode: number | null): MeshAgentAuthState;
}
