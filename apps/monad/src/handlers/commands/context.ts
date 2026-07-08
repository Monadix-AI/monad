// Builds the narrow CommandRunContext a command runs against. The session verbs are backed by an
// injectable SessionNavigator because their meaning differs per client: a channel multiplexes many
// sessions over one chat (conversation-keyed), while web/ACP/CLI navigate sessions client-side
// (principal-scoped). Everything else (reset/compact/model/listCommands) is daemon-uniform.

import type { CommandItem, PrincipalId } from '@monad/protocol';
import type {
  BeliefExplanation,
  CommandModelInfo,
  CommandRunContext,
  CommandSessionInfo,
  CompactSummary,
  ConsolidateSummary,
  ContradictionCheckSummary
} from '@monad/sdk-atom';

export interface SessionNavigator {
  newSession(label?: string): Promise<{ sessionId: string }>;
  listSessions(): Promise<CommandSessionInfo[]>;
  switchSession(target: string): Promise<CommandSessionInfo | null>;
}

// `sessionId` here is plain `string` (matching @monad/sdk-atom's CommandRunContext.sessionId), not
// `SessionId`: the generic (principal-scoped) command bridge in session-commands.ts can pass a
// Workplace Project's own id through this same path (project-wide command execution) — see the
// SessionOrProject TODO(track-b) in apps/monad/src/handlers/session/context.ts. Individual command
// implementations that are genuinely session-only (compact/model/belief/handoff) narrow via their
// own `sessionOnlyId` guard before calling out.
/** Daemon-uniform backing for the non-navigation verbs. */
export interface CommandServices {
  resetHistory(sessionId: string): Promise<{ clearedCount: number }>;
  compact(sessionId: string): Promise<CompactSummary>;
  consolidate(level?: number): Promise<ConsolidateSummary>;
  explainBelief(sessionId: string, query: string): Promise<BeliefExplanation>;
  checkMemory(): Promise<ContradictionCheckSummary>;
  listModels(sessionId: string): Promise<CommandModelInfo[]>;
  setModel(sessionId: string, alias: string): Promise<void>;
  getWorkdir(sessionId: string): Promise<{ path?: string }>;
  setWorkdir(sessionId: string, path: string): Promise<{ path?: string }>;
  listCommands(): Promise<CommandItem[]>;
  handoff(sessionId: string, initialTask?: string): Promise<{ sessionId: string }>;
  /** Active-locale translator, shared across every command on this transport. */
  t: CommandRunContext['t'];
  log: CommandRunContext['log'];
}

export function makeCommandRunContext(p: {
  sessionId: string;
  principalId: PrincipalId;
  args: string;
  nav: SessionNavigator;
  services: CommandServices;
}): CommandRunContext {
  const { sessionId, principalId, args, nav, services } = p;
  return {
    sessionId,
    principalId,
    args,
    newSession: (label) => nav.newSession(label),
    listSessions: () => nav.listSessions(),
    switchSession: (target) => nav.switchSession(target),
    resetHistory: () => services.resetHistory(sessionId),
    compact: () => services.compact(sessionId),
    consolidate: (level) => services.consolidate(level),
    explainBelief: (query) => services.explainBelief(sessionId, query),
    checkMemory: () => services.checkMemory(),
    listModels: () => services.listModels(sessionId),
    setModel: (alias) => services.setModel(sessionId, alias),
    getWorkdir: () => services.getWorkdir(sessionId),
    setWorkdir: (path) => services.setWorkdir(sessionId, path),
    listCommands: () => services.listCommands(),
    handoff: (initialTask) => services.handoff(sessionId, initialTask),
    t: services.t,
    log: services.log
  };
}
