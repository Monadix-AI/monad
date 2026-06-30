// Bridges the unified CommandRegistry to the daemon's generic (non-channel) transports. Builds a
// principal-scoped SessionNavigator + CommandServices, runs the command, and emits the reply as a
// persisted directive message plus a live event — so HTTP/ACP/WS/CLI all render it identically.

import type { Translate } from '@monad/i18n';
import type { ChatMessage, Event, PrincipalId, Session, SessionId, SessionOrigin } from '@monad/protocol';
import type {
  BeliefExplanation,
  CommandDefinition,
  CommandModelInfo,
  CommandResult,
  CommandSpec,
  CompactSummary,
  ConsolidateSummary,
  ContradictionCheckSummary
} from '@monad/sdk-atom';
import type { EventBus } from '@/services/event-bus.ts';
import type { Store } from '@/store/db/index.ts';

import { newId } from '@monad/protocol';

import { type CommandServices, makeCommandRunContext, type SessionNavigator } from './context.ts';
import { dispatchCommand } from './dispatch.ts';
import { type CommandRegistry, type SkillCommandView } from './registry.ts';

/** Everything needed to run one command for a session, regardless of transport. The channel and the
 *  generic transports build this with their own navigator/services, then share execute + emit. */
export interface CommandExecution {
  registry: CommandRegistry;
  navigator: SessionNavigator;
  services: CommandServices;
  principalId: PrincipalId;
  /** Approval gate for `highRisk` commands (e.g. an atom pack command) — throws to deny. */
  gate?: (def: CommandDefinition) => Promise<void>;
  /** Caller is the daemon owner — gates `access: 'owner'` commands. Default true. */
  isOwner?: boolean;
  /** A turn is streaming for this session — gates non-`duringTurn` commands (concurrency guard). */
  isBusy?: boolean;
}

/** Parse + run a command (no emit). Returns the result, an error result if it threw, or null when
 *  the text is not a host command (plain text or a skill → caller's loop). */
export async function executeCommand(
  exec: CommandExecution,
  sessionId: SessionId,
  text: string
): Promise<CommandResult | null> {
  try {
    return await dispatchCommand(
      exec.registry,
      text,
      (args) =>
        makeCommandRunContext({
          sessionId,
          principalId: exec.principalId,
          args,
          nav: exec.navigator,
          services: exec.services
        }),
      { gate: exec.gate, isOwner: exec.isOwner, isBusy: exec.isBusy }
    );
  } catch (err) {
    return { message: exec.services.t('cmd.error', { message: (err as Error).message }) };
  }
}

/** Persist + publish a command turn (echo + directive reply) via the given emit. Both rows are
 *  `type:'directive'` → UI-visible but excluded from the model prompt and ContextEngine summary
 *  (replayHistory skips directive), so a command never costs tokens or pollutes context. The emit
 *  fans the events wherever the transport needs them (bus for cross-client; a per-turn sink/renderer
 *  for the originating channel/ACP turn). */
export function emitCommandTurn(
  store: Store,
  emit: (e: Event) => void,
  sessionId: SessionId,
  text: string,
  result: CommandResult
): ChatMessage {
  const userId = persistEcho(store, sessionId, text);
  emit(event(sessionId, 'user.message', { messageId: userId, text }));
  return emitDirective(store, emit, sessionId, result);
}

/** Session-lifecycle ops the command bridge needs — satisfied by the lifecycle handlers. */
export interface LifecycleOps {
  createForPrincipal(args: {
    title: string;
    principalId: PrincipalId;
    agentId?: string;
    origin?: SessionOrigin;
  }): Promise<{ sessionId: string }>;
  reset(args: { id: SessionId }): Promise<{ clearedCount: number }>;
  list(args: { limit?: number }): Promise<{ sessions: Session[] }>;
  setWorkspace(args: { id: SessionId; cwd: string }): Promise<Session>;
}

/** Backend hooks for the non-navigation verbs, wired in main.ts. */
export interface CommandBundle {
  registry: CommandRegistry;
  skills(): SkillCommandView[];
  listModels(sessionId: SessionId): Promise<CommandModelInfo[]>;
  setModel(sessionId: SessionId, alias: string): Promise<void>;
  compact(sessionId: SessionId): Promise<CompactSummary>;
  consolidate(level?: number): Promise<ConsolidateSummary>;
  explainBelief(sessionId: SessionId, query: string): Promise<BeliefExplanation>;
  checkMemory(): Promise<ContradictionCheckSummary>;
  handoff(sessionId: SessionId, initialTask?: string): Promise<{ sessionId: string }>;
  /** Route a `highRisk` command through human approval (oversight) before it runs; throws if denied. */
  approveHighRisk?(sessionId: SessionId, def: CommandDefinition): Promise<void>;
  /** Active-locale translator (hot-reloaded with config). */
  t: Translate;
  log: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

export interface SessionCommandRunner {
  store: Store;
  bus: EventBus;
  lifecycle: LifecycleOps;
  commands: CommandBundle;
  /** Daemon owner principal — a session owned by it is an owner-privileged caller (gates `access`). */
  ownerPrincipalId: PrincipalId;
}

/** A principal-scoped navigator for generic transports: it creates sessions and resolves targets,
 *  but holds no server-side "active session" pointer — the client navigates via the returned effect. */
function genericNavigator(runner: SessionCommandRunner, session: Session): SessionNavigator {
  const { lifecycle } = runner;
  const owned = async () => {
    const { sessions } = await lifecycle.list({ limit: 50 });
    return sessions.filter((s) => s.ownerPrincipalId === session.ownerPrincipalId);
  };
  return {
    async newSession(label) {
      const { sessionId } = await lifecycle.createForPrincipal({
        title: label ?? 'New conversation',
        principalId: session.ownerPrincipalId,
        agentId: session.agentIds[0],
        // A /new spawned inside a session inherits its provenance (a /new in Telegram → Telegram).
        origin: session.origin
      });
      return { sessionId };
    },
    async listSessions() {
      const list = await owned();
      return list.map((s) => ({ sessionId: s.id, label: s.title, active: s.id === session.id }));
    },
    async switchSession(target) {
      const list = await owned();
      const byIndex = /^\d+$/.test(target) ? list[Number(target) - 1] : undefined;
      const found = byIndex ?? list.find((s) => s.id === target);
      return found ? { sessionId: found.id, label: found.title, active: found.id === session.id } : null;
    }
  };
}

/** The generic (principal-scoped) execution context for a session command. */
function genericExecution(runner: SessionCommandRunner, session: Session, busy: boolean): CommandExecution {
  const { commands } = runner;
  const approve = commands.approveHighRisk;
  return {
    registry: commands.registry,
    navigator: genericNavigator(runner, session),
    principalId: session.ownerPrincipalId,
    isOwner: session.ownerPrincipalId === runner.ownerPrincipalId,
    isBusy: busy,
    gate: approve ? (def) => approve(session.id as SessionId, def) : undefined,
    services: {
      resetHistory: (sid: SessionId) => runner.lifecycle.reset({ id: sid }),
      compact: (sid: SessionId) => commands.compact(sid),
      consolidate: (level?: number) => commands.consolidate(level),
      explainBelief: (sid: SessionId, query: string) => commands.explainBelief(sid, query),
      checkMemory: () => commands.checkMemory(),
      listModels: (sid: SessionId) => commands.listModels(sid),
      setModel: (sid: SessionId, alias: string) => commands.setModel(sid, alias),
      getWorkdir: async (sid: SessionId) => ({ path: runner.store.getSession(sid)?.cwd }),
      setWorkdir: async (sid: SessionId, path: string) => ({
        path: (await runner.lifecycle.setWorkspace({ id: sid, cwd: path })).cwd
      }),
      listCommands: async (): Promise<CommandSpec[]> => commands.registry.list(commands.skills(), commands.t),
      handoff: (sid: SessionId, initialTask?: string) => commands.handoff(sid, initialTask),
      t: commands.t,
      log: commands.log
    }
  };
}

/** Parse + run a slash command WITHOUT emitting. Returns the result, an error result if the command
 *  threw, or null when the text is not a host command (plain text or a skill → caller's loop). */
export function executeSessionCommand(
  runner: SessionCommandRunner,
  session: Session,
  text: string,
  opts: { busy?: boolean } = {}
): Promise<CommandResult | null> {
  return executeCommand(genericExecution(runner, session, opts.busy ?? false), session.id as SessionId, text);
}

/** Run a slash command and emit the turn. Returns true when handled (caller skips the loop), false
 *  when the text is not a host command. `sink` mirrors events to a per-turn consumer (ACP's inline
 *  prompt stream); `busy` flags that a turn is streaming (concurrency guard). */
export async function tryRunSessionCommand(
  runner: SessionCommandRunner,
  session: Session,
  text: string,
  opts: { sink?: (event: Event) => void; busy?: boolean } = {}
): Promise<boolean> {
  const result = await executeSessionCommand(runner, session, text, { busy: opts.busy });
  if (result === null) return false;
  const { store, bus } = runner;
  emitCommandTurn(
    store,
    (e) => {
      bus.publish(e);
      opts.sink?.(e);
    },
    session.id as SessionId,
    text,
    result
  );
  return true;
}

/** Persist a command turn (echo + directive reply) and return the reply ChatMessage. Used by the
 *  blocking `generate` path, where the reply is the response body. */
function _directiveMessage(store: Store, sessionId: SessionId, text: string, result: CommandResult): ChatMessage {
  persistEcho(store, sessionId, text);
  const id = newId('msg');
  const createdAt = new Date().toISOString();
  const data = result.effect ? { effect: result.effect } : undefined;
  store.insertMessage(id, sessionId, result.message ?? '', createdAt, 'assistant', { type: 'directive', data });
  return {
    id,
    sessionId,
    role: 'assistant',
    text: result.message ?? '',
    type: 'directive',
    data,
    stream: { status: 'complete' },
    active: true,
    createdAt
  };
}

function persistEcho(store: Store, sessionId: SessionId, text: string): `msg_${string}` {
  const id = newId('msg');
  store.insertMessage(id, sessionId, text, new Date().toISOString(), 'user', { type: 'directive' });
  return id;
}

function emitDirective(
  store: Store,
  emit: (e: Event) => void,
  sessionId: SessionId,
  result: CommandResult
): ChatMessage {
  const id = newId('msg');
  const text = result.message ?? '';
  const createdAt = new Date().toISOString();
  const data = result.effect ? { effect: result.effect } : undefined;
  store.insertMessage(id, sessionId, text, createdAt, 'assistant', { type: 'directive', data });
  emit(event(sessionId, 'agent.message', { messageId: id, text, ...(data !== undefined ? { data } : {}) }));
  return {
    id,
    sessionId,
    role: 'assistant',
    text,
    type: 'directive',
    data,
    stream: { status: 'complete' },
    active: true,
    createdAt
  };
}

function event(sessionId: SessionId, type: Event['type'], payload: Record<string, unknown>): Event {
  return { id: newId('evt'), sessionId, type, actorAgentId: null, payload, at: new Date().toISOString() };
}
