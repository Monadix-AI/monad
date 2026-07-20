import type { Event, MeshAgentAuthStatusResponse, SessionId } from '@monad/protocol';
import type { EventBus } from '#/services/event-bus.ts';

import { createLogger } from '@monad/logger';
import { parseEventPayload } from '@monad/protocol';

import { makeEvent } from '#/services/event-bus.ts';

interface MeshAgentLoginNudgeDeps {
  bus: EventBus;
  authStatus: (agentName: string) => Promise<MeshAgentAuthStatusResponse>;
}

interface PendingLoginCard {
  sessionId: SessionId;
  agentName: string;
  authAgentName: string;
  provider: string;
  reason: string;
  meshSessionId?: string;
}

/** Turns a provider connection_required signal into an ephemeral in-chat login nudge. On every
 *  `mesh.connection_required` it probes the provider CLI's real auth state first — only a
 *  confirmed `unauthenticated` publishes `mesh.login_required` (bus-only, never persisted),
 *  so the card exists exactly while re-login is actually needed. When the auth host later reports a
 *  successful login for that agent, every session holding a card gets `mesh.login_resolved`
 *  and the projection removes it. */
export class MeshAgentLoginNudge {
  private readonly log = createLogger('mesh-agent');
  private readonly pending = new Map<string, Map<string, PendingLoginCard>>();
  private readonly probing = new Set<string>();

  constructor(private readonly deps: MeshAgentLoginNudgeDeps) {}

  start(): () => void {
    return this.deps.bus.subscribeAll((event) => {
      if (event.type !== 'mesh.connection_required') return;
      void this.onConnectionRequired(event);
    });
  }

  private async onConnectionRequired(event: Event): Promise<void> {
    const p = parseEventPayload('mesh.connection_required', event.payload);
    if (p.code === 'provider_disabled' || p.code === 'provider_unavailable') return;
    const authAgentName = p.authAgentName ?? p.agentName;
    const probeKey = `${p.agentName}:${authAgentName}:${event.sessionId}`;
    if (this.probing.has(probeKey)) return;
    this.probing.add(probeKey);
    try {
      const status = await this.deps.authStatus(authAgentName).catch(() => null);
      if (status?.state !== 'unauthenticated') {
        if (status?.state === 'authenticated')
          this.resolveAuthenticated({ agentName: authAgentName, provider: p.provider });
        return;
      }
      let sessions = this.pending.get(authAgentName);
      if (!sessions) {
        sessions = new Map();
        this.pending.set(authAgentName, sessions);
      }
      sessions.set(`${event.sessionId}:${p.agentName}`, {
        sessionId: event.sessionId as SessionId,
        ...(p.meshSessionId ? { meshSessionId: p.meshSessionId } : {}),
        agentName: p.agentName,
        authAgentName,
        provider: p.provider,
        reason: p.reason
      });
      this.deps.bus.publish(
        makeEvent(event.sessionId as SessionId, 'mesh.login_required', {
          ...(p.meshSessionId ? { meshSessionId: p.meshSessionId } : {}),
          agentName: p.agentName,
          authAgentName,
          provider: p.provider,
          reason: p.reason
        })
      );
    } catch (error) {
      this.log.warn(
        {
          event: 'mesh.login_nudge_failed',
          agentName: p.agentName,
          err: error instanceof Error ? { message: error.message } : String(error)
        },
        'login nudge probe failed'
      );
    } finally {
      this.probing.delete(probeKey);
    }
  }

  pendingLoginRequiredEvents(sessionId: SessionId): Event[] {
    const events: Event[] = [];
    for (const sessions of this.pending.values()) {
      for (const card of sessions.values()) {
        if (card.sessionId !== sessionId) continue;
        events.push(
          makeEvent(sessionId, 'mesh.login_required', {
            ...(card.meshSessionId ? { meshSessionId: card.meshSessionId } : {}),
            agentName: card.agentName,
            authAgentName: card.authAgentName,
            provider: card.provider,
            reason: card.reason
          })
        );
      }
    }
    return events;
  }

  resolveAuthenticated(info: { agentName: string; provider: string }): void {
    const sessions = this.pending.get(info.agentName);
    if (!sessions?.size) return;
    this.pending.delete(info.agentName);
    for (const card of sessions.values()) {
      this.deps.bus.publish(
        makeEvent(card.sessionId, 'mesh.login_resolved', {
          agentName: card.agentName,
          provider: card.provider
        })
      );
    }
  }
}
