import type {
  AdapterMigrationApplyRequest,
  AdapterMigrationApplyResult,
  AdapterMigrationCandidate,
  AdapterMigrationPreview,
  AdapterMigrationPreviewRequest,
  NativeCliAgentPresetView,
  NativeCliAgentSetting,
  NativeCliAgentView,
  NativeCliAppServerTransport,
  NativeCliAuthState,
  NativeCliHistoryPageRequest,
  NativeCliLaunchMode,
  NativeCliObservationEvent,
  NativeCliProductIcon,
  NativeCliProvider,
  NativeCliUsageRecord
} from '@monad/protocol';
import type { BinProbes } from './bin-probes.ts';

import { z } from 'zod';

export type NativeCliErrorCode =
  | 'provider_not_installed'
  | 'provider_not_logged_in'
  | 'unsupported_capability'
  | 'provider_timeout'
  | 'provider_protocol_error';

export class NativeCliError extends Error {
  constructor(
    readonly code: NativeCliErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'NativeCliError';
  }
}

type NativeCliCapability =
  | NativeCliLaunchMode
  | 'provider-approval'
  | 'approval-resolution'
  | 'structured-output'
  | 'session-resume'
  | 'rollout-json-fallback';

/** `ws`-transport dial hints a `buildLaunch` can attach to its `NativeCliLaunchSpec` when the default
 *  "scan the child's stderr for a self-announced `ws://host:port` line" dial strategy doesn't fit the
 *  provider's real gateway (e.g. it prints a differently-shaped announce line, announces on stdout
 *  instead of stderr, serves at a non-root path, or needs query-string auth). */
interface NativeCliAppServerWsHints {
  /** URL path appended after `ws://host:port` (e.g. `/api/ws`). Root (`''`) by default. */
  path?: string;
  /** Query-string params merged into the dial URL (e.g. a shared-secret token). */
  query?: Record<string, string>;
  /** When set, the daemon dials this EXACT port directly (retrying until the child accepts, or the
   *  launch timeout elapses) instead of scanning stdout/stderr for a self-announced port — for a
   *  gateway the daemon itself launched with an explicit `--port` flag (see
   *  `BuildNativeCliLaunchOptions.appServerPort`). */
  port?: number;
}

export interface NativeCliLaunchSpec {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  launchMode: NativeCliLaunchMode;
  /** Byte channel for `app-server` launches. Absent (or `stdio`) means the daemon owns the child's
   *  stdin/stdout; `ws`/`unix` mean the child listens and the daemon dials the socket. */
  appServerTransport?: NativeCliAppServerTransport;
  /** `ws`-transport dial hints; absent → the daemon's default self-announced-port scan. */
  appServerWs?: NativeCliAppServerWsHints;
  provider: NativeCliProvider;
  approvalOwnership: 'provider-owned';
  capabilities: NativeCliCapability[];
}

export type NativeCliStartPreflight =
  | { state: 'ready'; agentName: string; provider: NativeCliProvider; checkedAt: string; providerSessionRef?: string }
  | {
      state: 'not_authenticated';
      agentName: string;
      provider: NativeCliProvider;
      checkedAt: string;
      action: 'reconnect_in_studio';
      reason: string;
    }
  | {
      state: 'unavailable';
      agentName: string;
      provider: NativeCliProvider;
      checkedAt: string;
      reason: string;
    }
  | {
      state: 'unknown';
      agentName: string;
      provider: NativeCliProvider;
      checkedAt: string;
      action: 'manual_check_in_studio';
      reason: string;
    };

export interface BuildNativeCliLaunchOptions {
  workingPath: string;
  extraWorkingPaths?: string[];
  launchMode?: NativeCliLaunchMode;
  appServerTransport?: NativeCliAppServerTransport;
  /** For `appServerTransport: 'unix'`, the AF_UNIX socket path the daemon allocated for the child to
   *  listen on (`--listen unix://<path>`). Ignored by other transports. */
  appServerSocketPath?: string;
  /** For `appServerTransport: 'ws'` when the daemon pre-allocates the loopback port (rather than
   *  parsing it from the child's announce output) — a `buildLaunch` that uses this must echo it back
   *  as `NativeCliLaunchSpec.appServerWs.port` so the daemon knows to skip announce-scanning. */
  appServerPort?: number;
  providerSessionRef?: string;
  systemPromptFile?: string;
  skipProviderApprovals?: boolean;
  modelName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  mcpConfigArgs?: string[];
}

export interface NativeCliOutputEvent {
  type:
    | 'approval_requested'
    | 'approval_resolved'
    | 'agent_message'
    | 'connection_required'
    | 'history_page'
    | 'provider_error'
    | 'session_ref'
    | 'tool_call'
    | 'tool_result'
    | 'web_search_result';
  payload: Record<string, unknown>;
}

const requestIdSchema = z.union([z.string().min(1), z.number()]);
const nativeCliOutputPayloadBase = z.object({}).catchall(z.unknown());

export const nativeCliOutputEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session_ref'),
    payload: nativeCliOutputPayloadBase.extend({
      providerSessionRef: z.string().min(1)
    })
  }),
  z.object({
    type: z.literal('agent_message'),
    payload: nativeCliOutputPayloadBase.extend({
      text: z.string(),
      final: z.boolean().optional()
    })
  }),
  z.object({
    type: z.literal('tool_call'),
    payload: nativeCliOutputPayloadBase.extend({
      callId: z.union([z.string().min(1), z.number()]).optional(),
      tool: z.string().min(1).optional(),
      input: z.unknown().optional()
    })
  }),
  z.object({
    type: z.literal('tool_result'),
    payload: nativeCliOutputPayloadBase.extend({
      callId: z.union([z.string().min(1), z.number()]).optional(),
      output: z.unknown().optional()
    })
  }),
  z.object({
    type: z.literal('web_search_result'),
    payload: nativeCliOutputPayloadBase.extend({
      callId: z.union([z.string().min(1), z.number()]).optional(),
      status: z.string().optional()
    })
  }),
  z.object({
    type: z.literal('connection_required'),
    payload: nativeCliOutputPayloadBase.extend({
      code: z.string().min(1).optional(),
      reason: z.string().min(1)
    })
  }),
  z.object({
    type: z.literal('provider_error'),
    payload: nativeCliOutputPayloadBase.extend({
      responseId: z.union([z.string().min(1), z.number()]).optional(),
      code: z.union([z.string().min(1), z.number()]).optional(),
      message: z.string().min(1)
    })
  }),
  z.object({
    type: z.literal('history_page'),
    payload: nativeCliOutputPayloadBase.extend({
      responseId: z.union([z.string().min(1), z.number()]),
      items: z.array(z.unknown()),
      nextCursor: z.string().nullable(),
      backwardsCursor: z.string().nullable()
    })
  }),
  z.object({
    type: z.literal('approval_requested'),
    payload: nativeCliOutputPayloadBase.extend({
      requestId: requestIdSchema,
      kind: z.string().min(1)
    })
  }),
  z.object({
    type: z.literal('approval_resolved'),
    payload: nativeCliOutputPayloadBase.extend({
      requestId: requestIdSchema
    })
  })
]);

/** Transport-neutral outbound frame channel for an `app-server` launch. The daemon owns which
 *  physical transport backs it (the child's stdin pipe for `stdio`, a WebSocket for `ws`, a socket
 *  for `unix`) and hands the adapter this uniform interface — an adapter frames JSON-RPC and calls
 *  `send`; it never learns whether the bytes travel over a pipe or a socket. */
export interface NativeCliAppServerConnection {
  send(frame: string): void;
  close(): void;
}

export interface NativeCliRuntimeHandle {
  terminal?: {
    write(input: string): void;
    resize(cols: number, rows: number): void;
    close(): void;
  };
  /** Raw byte pipe to the child's stdin — the delivery channel for `json-stream` adapters that
   *  write newline-delimited JSON. `app-server` adapters use `appServer` instead, so the transport
   *  (pipe vs socket) stays hidden from them. */
  stdin?: {
    write(input: string): void;
    flush?(): void | Promise<void>;
    end?(): void | Promise<void>;
  };
  /** Frame channel for `app-server` sessions, present regardless of the physical transport the
   *  daemon dialled (stdio/ws/unix). */
  appServer?: NativeCliAppServerConnection;
  launchMode?: NativeCliLaunchMode;
  providerSessionRef?: string | null;
  nextRequestId?(): number;
  /** Per-session JSON-RPC request→kind ledger. An adapter records what each outbound request id was
   *  for (e.g. `thread` / `historyPage`) so a later response can be dispatched by id rather than by
   *  guessing its result shape. Present only for stdio/app-server sessions the host owns. */
  pendingRequests?: Map<string | number, string>;
  /** app-server: a `thread/start`|`thread/resume` frame parked until the `initialize` response lands,
   *  so the handshake is ordered per the protocol (requests before `initialized` are rejected). The
   *  adapter stashes it on init and flushes it when it dispatches the initialize response. */
  deferredThreadFrame?: string;
  /** app-server: id of the turn currently in flight, tracked from turn lifecycle notifications so the
   *  adapter can address `interrupt`/`steer` at it. Undefined between turns. */
  currentTurnId?: string;
  /** app-server: text of the last user turn, retained so a context-overflow error can auto-compact
   *  and re-run it (see the codex adapter's error handling). */
  lastTurnInput?: string;
  /** app-server: how many times the current turn has been auto-recovered (e.g. compacted on context
   *  overflow), to bound the retry loop. Reset when the turn settles. */
  turnRecoveries?: number;
  kill(signal?: NodeJS.Signals): void;
}

export interface NativeCliProviderHistoryContext {
  providerSessionRef: string;
  workingPath: string;
  limitBytes: number;
}

export interface NativeCliProviderHistoryPageContext extends NativeCliProviderHistoryContext {
  /** Raw provider records to reshape into the live-JSONL-mimicking output string — not the daemon's
   *  wire response shape (that carries normalized `events`, not raw items). */
  page: { items: unknown[]; nextCursor?: string };
}

export interface NativeCliProviderHistoryPageRequestContext extends NativeCliProviderHistoryContext {
  request: NativeCliHistoryPageRequest;
}

export interface NativeCliApprovalResolution {
  requestId: string;
  allow: boolean;
  reason?: string;
  request?: Record<string, unknown>;
}

export interface NativeCliInitializeContext {
  workingPath: string;
  providerSessionRef?: string;
  developerInstructions?: string;
  modelName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  /** The agent's operator-configured env map (same one `buildLaunch` passes to the child process).
   *  An app-server adapter whose gateway takes a shared-secret credential (e.g. a token env var the
   *  gateway process itself reads) uses this to send the matching credential over the wire — the
   *  credential is explicit per-agent config, not a Monad-invented ambient env var. */
  env?: Record<string, string>;
}

export interface NativeCliAuthStatusProbe {
  launch: NativeCliLaunchSpec;
  parse(output: string, exitCode: number | null): NativeCliAuthState;
}

export interface NativeCliModelOptionsProbe {
  launch: NativeCliLaunchSpec;
  parse(output: string, exitCode: number | null): string[];
}

export interface NativeCliUsageProbe {
  launch: NativeCliLaunchSpec;
  parse(output: string, exitCode: number | null): NativeCliUsageRecord[];
}

export type NativeCliObservationJsonRecordEntry = {
  record: Record<string, unknown>;
  raw: string;
};

export type NativeCliObservationMessageGroupProjector = {
  append(group: unknown, entry: NativeCliObservationJsonRecordEntry): void;
  create(record: Record<string, unknown>): { key: string; state: unknown } | undefined;
  render(id: string, group: unknown): NativeCliObservationEvent[];
};

export type NativeCliObservationRecordProjector = {
  parse(args: {
    id: string;
    provider?: string;
    record: Record<string, unknown>;
    recordIndex: number;
  }): NativeCliObservationEvent[];
  supports?(record: Record<string, unknown>): boolean;
};

export type NativeCliObservationUsageProjector = {
  usageRecords?(record: Record<string, unknown>): NativeCliUsageRecord[];
};

/** Provider-agnostic classification of a projected observation event. The adapter (which owns its
 *  provider's event vocabulary) maps each event it produces to one of these kinds; consumers derive
 *  turn/generating state and the UI activity phase from the kind, never from a provider event string.
 *  `turn-end` marks a terminal record (result / turn completed / error). */
export type NativeCliObservationActivity =
  | 'thinking'
  | 'message'
  | 'tool-call'
  | 'tool-result'
  | 'user'
  | 'system'
  | 'turn-end';

export type NativeCliObservationProjector = NativeCliObservationUsageProjector & {
  historyEntries?(entries: NativeCliObservationJsonRecordEntry[]): NativeCliObservationJsonRecordEntry[];
  messageGroup?: NativeCliObservationMessageGroupProjector;
  recordProjectors: NativeCliObservationRecordProjector[];
  /** Classify one event this adapter produced into a provider-agnostic activity kind. Returning
   *  `undefined` means "no signal" (the event doesn't affect generating/phase). Consumers fall back
   *  to a role-only heuristic when an adapter omits this. */
  classifyActivity?(event: NativeCliObservationEvent): NativeCliObservationActivity | undefined;
  /** Whether an event is a partial streaming fragment (a token delta) rather than a settled item.
   *  Consumers use it to merge adjacent fragments and to drive streaming affordances, without knowing
   *  this provider's delta event names. */
  isStreamingFragment?(event: NativeCliObservationEvent): boolean;
};

export interface NativeCliArgumentSupport {
  flags: string[];
  reasoningEfforts: string[];
  speeds: string[];
  /** Reasoning efforts supported per model slug (e.g. codex reports these per model). Lets a picker
   *  offer only the efforts a selected model actually supports; `reasoningEfforts` is their union. */
  reasoningEffortsByModel?: Record<string, string[]>;
}

export interface NativeCliArgumentSupportProbe {
  launch: NativeCliLaunchSpec;
  parse(output: string, exitCode: number | null): NativeCliArgumentSupport;
}

export interface NativeCliManagedRuntimeContext {
  monadCliEntry: {
    command: string;
    args: string[];
  };
  env: Record<string, string>;
}

export interface NativeCliManagedEnvContext {
  /** The managed agent's private workspace directory (already created on disk). A provider whose
   *  autopilot toggle has no CLI-flag equivalent (e.g. OpenClaw — see its adapter) writes its own
   *  config/state files here and points the child at them via env vars, rather than an argv flag. */
  workspace: string;
  /** The resolved `allowAutopilot` outcome for this launch: true → the provider should run unattended
   *  (skip its own approval prompts); false → it should prompt as normal so the daemon's approval
   *  channel (where supported) can project and resolve those requests. */
  skipProviderApprovals: boolean;
}

/** Provider-specific behavior for a *managed* project-agent runtime — a native CLI that monad spawns
 *  and supervises as a Workplace project member. Absent → the generic defaults apply, so the daemon's
 *  managed-runtime code stays provider-agnostic and reads intent from the adapter instead of branching
 *  on the provider id. */
export interface NativeCliManagedRuntime {
  /** Launch-mode override for the managed runtime (e.g. codex → 'app-server', others → 'json-stream'). */
  launchMode?(defaultMode: NativeCliLaunchMode): NativeCliLaunchMode;
  /** Env additions for the managed child (e.g. codex → `CODEX_NON_INTERACTIVE=1`). */
  env?(context: NativeCliManagedEnvContext): Record<string, string>;
  /** CLI args wiring monad's managed MCP server into the provider (codex → `-c mcp_servers.monad…`). */
  mcpConfigArgs?(context: NativeCliManagedRuntimeContext): string[];
  /** The provider mounts monad's managed MCP server as its project bridge — drives the MCP prompt
   *  template, the MCP-flavored join greeting, and the MCP tool-usage communication instructions. */
  usesManagedMcpBridge?: boolean;
  /** The managed prompt is delivered as an appended system-prompt file (claude-code). */
  usesSystemPromptFile?: boolean;
  /** The managed prompt is delivered as developer instructions on session init (codex app-server). */
  usesDeveloperInstructions?: boolean;
}

/** ACP (Agent Client Protocol) delivery variant — the SAME agent launched as an external ACP
 *  sub-agent (an `npx` wrapper package bridging the agent's own SDK) instead of driven as a native
 *  CLI. Present only on agents that ship an ACP wrapper (codex, claude-code); the daemon's ACP
 *  delegation derives its invite preset + spawn command from this, while the agent's identity and
 *  install detection still come from `detect()` — one adapter, forked by delivery mode. */
export interface NativeCliAcpDelivery {
  /** Spawn command for the ACP wrapper (e.g. `npx`). */
  command: string;
  /** Args for the ACP wrapper (e.g. `['-y', '@agentclientprotocol/codex-acp@1.0.0']`). */
  args: string[];
  /** Optional auth env forwarded to the wrapper as secret refs (e.g. `{ OPENAI_API_KEY: '${env:OPENAI_API_KEY}' }`). */
  env?: Record<string, string>;
}

export interface AdapterMigration {
  /** Probe adapter-owned default migration sources, returning only paths that currently exist. */
  detect(probes?: BinProbes): AdapterMigrationCandidate[];
  /** Parse provider-specific settings into Monad's shared preview contract. */
  preview(request: AdapterMigrationPreviewRequest): AdapterMigrationPreview | Promise<AdapterMigrationPreview>;
  /** Optional adapter-side apply hook for out-of-process adapters. The daemon still owns Monad config
   *  writes for built-in migrations and uses this hook only when an adapter needs provider-owned apply. */
  apply?(request: AdapterMigrationApplyRequest): AdapterMigrationApplyResult | Promise<AdapterMigrationApplyResult>;
}
export type NativeCliSettingsImport = AdapterMigration;

/** The authoring contract for an agent-adapter atom: a native coding-CLI (Codex, Claude Code, …)
 *  wrapped as a monad agent. The daemon owns the process/pty/socket lifecycle and calls these hooks;
 *  the adapter only builds launch specs and translates the provider's wire format to/from
 *  `NativeCliOutputEvent`s. Registered through `AtomPackContext.registerAgentAdapter`. */
export interface NativeCliProviderAdapter {
  /** Provider-specific managed project-agent runtime behavior; absent → generic defaults. */
  managedRuntime?: NativeCliManagedRuntime;
  /** ACP delivery variant; absent → this agent has no ACP wrapper (native-CLI delivery only). */
  acp?: NativeCliAcpDelivery;
  /** Optional provider-specific migration surface. Current UI entry points may apply only a subset of
   *  categories (for example native CLI agents) even when the adapter previews broader settings. */
  settingsImport?: AdapterMigration;
  /** Optional provider-wire transcript projection into Monad protocol events. This is data-only:
   *  adapters may decode their own JSONL/history format, but must not return UI components, labels,
   *  cards, or view state. Experience surfaces consume only the resulting protocol events. */
  observation?: NativeCliObservationProjector;
  /** Declarative operator settings for this adapter. The UI renders these controls dynamically; keys
   *  address fields on `NativeCliAgentView` so daemon launch behavior still reads the shared contract. */
  settings?(agent?: NativeCliAgentView): NativeCliAgentSetting[];
  provider: NativeCliProvider;
  productIcon: NativeCliProductIcon;
  /** Human display name (e.g. "Claude Code", "Codex") — the single source the daemon/UI reads instead
   *  of mapping a provider id to a label. */
  label: string;
  detect(probes?: BinProbes): NativeCliAgentPresetView;
  listSupportedModels(agent?: NativeCliAgentView): string[];
  modelOptions?(agent: NativeCliAgentView): NativeCliModelOptionsProbe;
  resolveCommand?(command: string, probes?: BinProbes): string | undefined;
  buildLaunch(agent: NativeCliAgentView, opts: BuildNativeCliLaunchOptions): NativeCliLaunchSpec;
  /** True when this provider's `ws` app-server launches want a daemon-assigned port (see
   *  `NativeCliAppServerWsHints.port`) rather than a self-announced one. The daemon uses this to decide
   *  whether pre-allocating a port before `buildLaunch` runs is worth the syscall — a self-announcing ws
   *  provider that doesn't set this never reads the allocated port at all. */
  usesDaemonAssignedAppServerPort?: boolean;
  /** `cli-oneshot` launch mode only: build the per-turn argv SUFFIX (the directive + any resume
   *  selector) appended to the launch spec's base argv each time the daemon spawns a fresh process for
   *  a turn. Absent → the adapter has no one-shot mode. */
  oneshotTurnArgs?(input: string, opts: { providerSessionRef?: string | null }): string[];
  buildAuthLaunch(agent: NativeCliAgentView): NativeCliLaunchSpec;
  buildAuthStatusLaunch(agent: NativeCliAgentView): NativeCliLaunchSpec;
  authStatus(agent: NativeCliAgentView): NativeCliAuthStatusProbe;
  argumentSupport?(agent: NativeCliAgentView): NativeCliArgumentSupportProbe;
  usage?(agent: NativeCliAgentView): NativeCliUsageProbe;
  parseAuthStatus(output: string, exitCode: number | null): NativeCliAuthState;
  historyPage?(
    context: NativeCliProviderHistoryPageRequestContext
  ): Promise<NativeCliProviderHistoryPageContext['page'] | null>;
  requestHistoryPage?(handle: NativeCliRuntimeHandle, request: NativeCliHistoryPageRequest): string | number;
  historyPageOutput?(context: NativeCliProviderHistoryPageContext): string | null;
  historyOutput?(context: NativeCliProviderHistoryContext): string | null | Promise<string | null>;
  initialize?(handle: NativeCliRuntimeHandle, context: NativeCliInitializeContext): void;
  /** `handle`, when present, gives per-session JSON-RPC context: the request→kind ledger for by-id
   *  response dispatch and a stdin sink for replying to unhandled server-initiated requests. Adapters
   *  that don't need it (single-shot stdout parsers) ignore it. */
  parseOutput(chunk: string, handle?: NativeCliRuntimeHandle): NativeCliOutputEvent[];
  sendInput(handle: NativeCliRuntimeHandle, input: string): void;
  /** True when the given launch mode can both project provider approval requests as
   *  `approval_requested` events AND resolve them via `resolveApproval` (a two-way channel exists).
   *  The daemon consults this before dropping the skip-approval flag for a managed agent: only a
   *  resolvable mode may delegate approvals to the human; otherwise it stays full-auto. Absent → the
   *  adapter has no resolvable approval channel in any mode. */
  supportsApprovalResolution?(launchMode: NativeCliLaunchMode): boolean;
  resolveApproval(handle: NativeCliRuntimeHandle, resolution: NativeCliApprovalResolution): void;
  /** Cancel the in-flight turn without tearing down the session/thread (app-server only). Absent →
   *  the provider offers no graceful interrupt; the host falls back to stopping the session. */
  interrupt?(handle: NativeCliRuntimeHandle): void;
  /** Inject additional input into the in-flight turn (app-server only). Absent → not supported. */
  steer?(handle: NativeCliRuntimeHandle, input: string): void;
  resize(handle: NativeCliRuntimeHandle, cols: number, rows: number): void;
  stop(handle: NativeCliRuntimeHandle): void;
}
