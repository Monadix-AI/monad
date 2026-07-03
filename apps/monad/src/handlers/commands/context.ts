// Builds the narrow CommandRunContext a command runs against. The session verbs are backed by an
// injectable SessionNavigator because their meaning differs per client: a channel multiplexes many
// sessions over one chat (conversation-keyed), while web/ACP/CLI navigate sessions client-side
// (principal-scoped). Everything else (reset/compact/model/listCommands) is daemon-uniform.

import type { PrincipalId, TranscriptTargetId } from '@monad/protocol';
import type {
  BeliefExplanation,
  CommandModelInfo,
  CommandRunContext,
  CommandSessionInfo,
  CommandSpec,
  CompactSummary,
  ConsolidateSummary,
  ContradictionCheckSummary
} from '@monad/sdk-atom';

export interface SessionNavigator {
  newSession(label?: string): Promise<{ sessionId: string }>;
  listSessions(): Promise<CommandSessionInfo[]>;
  switchSession(target: string): Promise<CommandSessionInfo | null>;
}

/** Daemon-uniform backing for the non-navigation verbs. */
export interface CommandServices {
  resetHistory(sessionId: TranscriptTargetId): Promise<{ clearedCount: number }>;
  compact(sessionId: TranscriptTargetId): Promise<CompactSummary>;
  consolidate(level?: number): Promise<ConsolidateSummary>;
  explainBelief(sessionId: TranscriptTargetId, query: string): Promise<BeliefExplanation>;
  checkMemory(): Promise<ContradictionCheckSummary>;
  listModels(sessionId: TranscriptTargetId): Promise<CommandModelInfo[]>;
  setModel(sessionId: TranscriptTargetId, alias: string): Promise<void>;
  getWorkdir(sessionId: TranscriptTargetId): Promise<{ path?: string }>;
  setWorkdir(sessionId: TranscriptTargetId, path: string): Promise<{ path?: string }>;
  listCommands(): Promise<CommandSpec[]>;
  handoff(sessionId: TranscriptTargetId, initialTask?: string): Promise<{ sessionId: string }>;
  /** Active-locale translator, shared across every command on this transport. */
  t: CommandRunContext['t'];
  log: CommandRunContext['log'];
}

export function makeCommandRunContext(p: {
  sessionId: TranscriptTargetId;
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
