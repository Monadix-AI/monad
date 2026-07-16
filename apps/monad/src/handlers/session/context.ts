import type { MonadPaths } from '@monad/environment';
import type { Logger } from '@monad/logger';
import type { Event, EventType, Hooks, Session, SessionId, SessionMcpServer } from '@monad/protocol';
import type { Agent, LoadedSkill } from '#/agent/index.ts';
import type { McpConnection } from '#/capabilities/tools';
import type { Tool, ToolBackends } from '#/capabilities/tools/types.ts';
import type { ConfigAccess } from '#/config/manager.ts';
import type { CommandBundle } from '#/handlers/commands/index.ts';
import type { DelegationService } from '#/services/delegation/delegation.ts';
import type { EventBus, EventSink } from '#/services/event-bus.ts';
import type { ExternalAgentHost } from '#/services/external-agent/host/index.ts';
import type { I18nService } from '#/services/i18n.ts';
import type { KvService } from '#/services/kv.ts';
import type { OversightService } from '#/services/oversight.ts';
import type { RoundCache } from '#/services/round-cache.ts';
import type { SessionSandboxService } from '#/services/session-sandbox.ts';
import type { Store } from '#/store/db/index.ts';

import { HandlerError } from '#/handlers/handler-error.ts';
import { SessionSteerMailbox } from '#/handlers/session/steer-mailbox.ts';
import { makeEvent } from '#/services/event-bus.ts';

export type Disposer = () => void;
export type { EventSink };

export interface SessionDeps {
  store: Store;
  agent: Agent;
  bus: EventBus;
  cache: RoundCache;
  log?: Logger;
  /** Distributed-state handle (embedded KV via Bun.RedisClient; cloud swaps in real Redis). Retained
   *  as the reuse seam — no session-layer consumer today (cross-process resume was intentionally dropped). */
  kv?: KvService;
  localeService?: Pick<I18nService, 't'>;
  oversight?: Pick<OversightService, 'cancelSession'>;
  /** Reverse fs/terminal delegation for ACP-bridged sessions. Absent → no delegation (daemon sandbox). */
  delegation?: DelegationService;
  /** Per-session ephemeral sandbox roots (sandbox mode 'ephemeral'). Absent → no per-session root. */
  sessionSandbox?: SessionSandboxService;
  /** Config file paths — used to resolve agents on session create. */
  paths?: Pick<MonadPaths, 'config' | 'agentsConfig' | 'mesh'>;
  configManager?: ConfigAccess;
  /** Slash-command backend (registry + model/compact/skill hooks). Absent → commands disabled. */
  commands?: CommandBundle;
  /** Lifecycle hooks — SessionStart/SessionEnd fire from the lifecycle handlers. */
  hooks?: Hooks;
  /** Session deletion undo grace. Defaults to the product grace period. */
  sessionDeleteGraceMs?: number;
  /** cwd handed to command hooks (the resolved sandbox root). */
  hookCwd?: string;
  /** Discover project-local skills from a cwd, called on session create when cwd is set. */
  discoverProjectSkills?: (cwd: string) => Promise<LoadedSkill[]>;
  /** Per-session tool exposure filter from the bound Studio agent's atoms allow/deny policy. Returns
   * undefined for unbound/unrestricted sessions; composed with any transport toolFilter on each turn. */
  agentToolFilter?: (sessionId: SessionId) => ((toolName: string) => boolean) | undefined;
  /** Per-session fs sandbox roots from the bound Studio agent's `sandbox` override (global ceiling
   * applied). Returns undefined when there's no override → the caller inherits the daemon default. */
  agentSandboxRoots?: (sessionId: SessionId) => string[] | undefined;
  externalAgentHost?: Pick<ExternalAgentHost, 'preflight' | 'input' | 'list' | 'start' | 'stop' | 'stopSession'>;
}

/** Execution config applied to every turn of a session, set out-of-band (the ACP bridge pushes the
 * editor's sandbox roots + session-scoped MCP tools via `configureRuntime`). Absent → daemon defaults. */
interface SessionRuntime {
  /** Replaces the daemon's configured sandbox roots for this session (e.g. the editor's cwd). */
  sandboxRoots?: string[];
  /** Session-scoped tools (e.g. client-provided MCP servers) added to the loop for this session. */
  extraTools?: Tool[];
  /** Serializable MCP server descriptors pushed for this session, reusable for outbound ACP delegation. */
  mcpServers?: SessionMcpServer[];
  /** Live MCP connections backing `extraTools`; closed when the session is deleted/closed. */
  mcpConnections?: McpConnection[];
  /** Delegating fs/terminal backends (ACP editor performs the ops) — installed when the session
   * advertised fs/terminal capability via configureRuntime's `delegate` flag. */
  backends?: ToolBackends;
  /** Drops daemon-host tools (process_*, code_execute, file_glob/grep) when execution is delegated. */
  toolFilter?: (toolName: string) => boolean;
  /** Project-local skills loaded from session.cwd/.monad/skills/ — merged into the loop for this session. */
  extraSkills?: LoadedSkill[];
}

export interface SessionContext {
  deps: SessionDeps;
  aborts: Map<SessionId, AbortController>;
  steers: Map<SessionId, SessionSteerMailbox>;
  /** Per-transcript execution config (see {@link SessionRuntime}); keyed by session or project id. */
  runtime: Map<SessionId, SessionRuntime>;
  requireSession(id: SessionId): Session;
  makeEmit(round: Event[]): (event: Event) => void;
  persistAndRetire(sessionId: SessionId, round: Event[]): void;
  emitLifecycle(sessionId: SessionId, type: EventType, payload: Record<string, unknown>): void;
  beginRun(sessionId: SessionId): { round: Event[]; signal: AbortSignal };
  enqueueSteers(sessionId: SessionId, messages: string[]): boolean;
  trackRun<T>(sessionId: SessionId, signal: AbortSignal, run: Promise<T>): Promise<T>;
  waitForRun(sessionId: SessionId): Promise<void>;
}

export function createSessionContext(deps: SessionDeps): SessionContext {
  const { store, bus, cache } = deps;
  const aborts = new Map<SessionId, AbortController>();
  const activeRuns = new Map<SessionId, Promise<void>>();
  const steers = new Map<SessionId, SessionSteerMailbox>();
  const runtime = new Map<SessionId, SessionRuntime>();

  function requireSession(id: SessionId): Session {
    const session = store.getSession(id);
    if (!session) throw new HandlerError('invalid', `session not found: ${id}`);
    return session;
  }

  function makeEmit(round: Event[]): (event: Event) => void {
    return (event: Event) => {
      cache.append(event);
      round.push(event);
      bus.publish(event);
      // A turn starting (user/channel message accepted) is the session's last activity — bump
      // updatedAt and fan a sessions.updated delta to the control stream so every client's session
      // list re-sorts to the top, even ones not viewing this session. Channel-originated turns flow
      // through here too, so a Telegram message bubbles the session up in the web sidebar live.
      if (event.type === 'user.message') bumpSessionActivity(event.sessionId);
    };
  }

  // Publish-only (not persisted via appendEvents): the control stream carries ephemeral list
  // deltas — a reconnecting client re-fetches the list — so a per-turn event row would only bloat
  // the log. Renames/state changes still persist through emitLifecycle.
  function bumpSessionActivity(sessionId: SessionId): void {
    const updated = store.updateSession(sessionId, {});
    if (!updated) return;
    bus.publish(makeEvent(sessionId, 'session.updated', { updatedAt: updated.updatedAt }));
  }

  // Publish-only stream-lifecycle markers (never persisted): they tell clients holding the control
  // stream *when* a turn is generating, so they open/close a per-session SSE subscription on demand.
  // Generation tokens themselves never travel the control/WS plane — only these coarse signals do.
  function emitStreamMarker(sessionId: SessionId, type: 'session.stream_started' | 'session.stream_ended'): void {
    bus.publish(makeEvent(sessionId, type, {}));
  }

  const TRANSIENT_EVENT_TYPES = new Set<EventType>([
    'agent.token',
    'agent.reasoning',
    'context.evicted',
    'context.handoff_suggested'
  ]);

  function persistAndRetire(sessionId: SessionId, round: Event[]): void {
    // agent.token / agent.reasoning are transient stream deltas — delivered live over the bus,
    // never persisted as event rows (the final agent.message carries the durable text).
    // context.evicted / context.handoff_suggested are transient notices — never persisted.
    store.appendEvents(round.filter((e) => !TRANSIENT_EVENT_TYPES.has(e.type)));
    cache.retire(sessionId);
    emitStreamMarker(sessionId, 'session.stream_ended');
  }

  function emitLifecycle(sessionId: SessionId, type: EventType, payload: Record<string, unknown>): void {
    const event: Event = makeEvent(sessionId, type, payload);
    store.appendEvents([event]);
    bus.publish(event);
  }

  function beginRun(sessionId: SessionId): { round: Event[]; signal: AbortSignal } {
    const round: Event[] = [];
    const controller = new AbortController();
    aborts.set(sessionId, controller);
    steers.set(sessionId, new SessionSteerMailbox());
    emitStreamMarker(sessionId, 'session.stream_started');
    return { round, signal: controller.signal };
  }

  function trackRun<T>(sessionId: SessionId, signal: AbortSignal, run: Promise<T>): Promise<T> {
    const settled = run.then(
      () => {},
      () => {}
    );
    activeRuns.set(sessionId, settled);
    void settled.then(() => {
      if (activeRuns.get(sessionId) === settled) activeRuns.delete(sessionId);
      if (aborts.get(sessionId)?.signal === signal) {
        aborts.delete(sessionId);
        steers.delete(sessionId);
      }
    });
    return run;
  }

  async function waitForRun(sessionId: SessionId): Promise<void> {
    await activeRuns.get(sessionId);
  }

  function enqueueSteers(sessionId: SessionId, messages: string[]): boolean {
    if (!activeRuns.has(sessionId)) return false;
    return steers.get(sessionId)?.enqueueMany(messages) ?? false;
  }

  return {
    deps,
    aborts,
    steers,
    runtime,
    requireSession,
    makeEmit,
    persistAndRetire,
    emitLifecycle,
    beginRun,
    enqueueSteers,
    trackRun,
    waitForRun
  };
}
