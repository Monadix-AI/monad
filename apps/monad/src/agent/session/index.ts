// session — agent-side run/session management. Persistence is injected via SessionRepo
// (the daemon backs it with @monad/store); agent-core stays storage-agnostic.

import type { AgentId, Session, SessionId, SessionOrigin, SessionState } from '@monad/protocol';

import { newId } from '@monad/protocol';

export interface SessionRepo {
  insertSession(s: Session): void | Promise<void>;
  getSession(id: string): Session | null | Promise<Session | null>;
}

/** Allowed session state transitions. Terminal states (completed/cancelled/failed) are sinks. */
const SESSION_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  active: ['paused', 'completed', 'cancelled', 'failed'],
  paused: ['active', 'completed', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: []
};

/** True if `to` is reachable from `from` (same-state is an allowed no-op). */
export function canTransition(from: SessionState, to: SessionState): boolean {
  if (from === to) return true;
  return SESSION_TRANSITIONS[from].includes(to);
}

export class SessionManager {
  constructor(private readonly repo: SessionRepo) {}

  async create(title: string, agentId?: AgentId, origin?: SessionOrigin, cwd?: string): Promise<Session> {
    return this.build(title, agentId, origin, cwd);
  }

  /** A session under a Workplace Project (Track B). Otherwise identical to `create` — same lineage,
   * same lifecycle — just tagged with the owning project. */
  async createForProject(
    projectId: Session['projectId'],
    title: string,
    origin?: SessionOrigin,
    cwd?: string,
    id?: SessionId
  ): Promise<Session> {
    return this.build(title, undefined, origin, cwd, projectId, id);
  }

  private async build(
    title: string,
    agentId?: AgentId,
    origin?: SessionOrigin,
    cwd?: string,
    projectId?: Session['projectId'],
    id?: SessionId
  ): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      id: id ?? newId('ses'),
      title,
      state: 'active',
      agentIds: agentId ? [agentId] : [],
      archived: false,
      restoreCount: 0,
      origin,
      cwd,
      projectId,
      createdAt: now,
      updatedAt: now
    };
    await this.repo.insertSession(session);
    return session;
  }
}
