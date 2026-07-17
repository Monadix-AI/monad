import type { Event, ExternalAgentAuthStatusResponse, SessionId } from '@monad/protocol';
import type { EventBus } from '#/services/event-bus.ts';

import { createLogger } from '@monad/logger';
import { parseEventPayload } from '@monad/protocol';

import { makeEvent } from '#/services/event-bus.ts';

export interface ExternalAgentLoginNudgeDeps {
  bus: EventBus;
  authStatus: (agentName: string) => Promise<ExternalAgentAuthStatusResponse>;
}

/** Turns a provider connection_required signal into an ephemeral in-chat login nudge. On every
 *  `external_agent.connection_required` it probes the provider CLI's real auth state first — only a
 *  confirmed `unauthenticated` publishes `external_agent.login_required` (bus-only, never persisted),
 *  so the card exists exactly while re-login is actually needed. When the auth host later reports a
 *  successful login for that agent, every session holding a card gets `external_agent.login_resolved`
 *  and the projection removes it. */
export class ExternalAgentLoginNudge {
  private readonly log = createLogger('external-agent');
  private readonly pending = new Map<string, Set<string>>();
  private readonly probing = new Set<string>();

  constructor(private readonly deps: ExternalAgentLoginNudgeDeps) {}

  start(): () => void {
    return this.deps.bus.subscribeAll((event) => {
      if (event.type !== 'external_agent.connection_required') return;
      void this.onConnectionRequired(event);
    });
  }

  private async onConnectionRequired(event: Event): Promise<void> {
    const p = parseEventPayload('external_agent.connection_required', event.payload);
    const probeKey = `${p.agentName}:${event.sessionId}`;
    if (this.probing.has(probeKey)) return;
    this.probing.add(probeKey);
    try {
      const status = await this.deps.authStatus(p.agentName).catch(() => null);
      if (status?.state !== 'unauthenticated') return;
      let sessions = this.pending.get(p.agentName);
      if (!sessions) {
        sessions = new Set();
        this.pending.set(p.agentName, sessions);
      }
      sessions.add(event.sessionId);
      this.deps.bus.publish(
        makeEvent(event.sessionId as SessionId, 'external_agent.login_required', {
          ...(p.externalAgentSessionId ? { externalAgentSessionId: p.externalAgentSessionId } : {}),
          agentName: p.agentName,
          provider: p.provider,
          reason: p.reason
        })
      );
    } catch (error) {
      this.log.warn(
        {
          event: 'external_agent.login_nudge_failed',
          agentName: p.agentName,
          err: error instanceof Error ? { message: error.message } : String(error)
        },
        'login nudge probe failed'
      );
    } finally {
      this.probing.delete(probeKey);
    }
  }

  resolveAuthenticated(info: { agentName: string; provider: string }): void {
    const sessions = this.pending.get(info.agentName);
    if (!sessions?.size) return;
    this.pending.delete(info.agentName);
    for (const sessionId of sessions) {
      this.deps.bus.publish(
        makeEvent(sessionId as SessionId, 'external_agent.login_resolved', {
          agentName: info.agentName,
          provider: info.provider
        })
      );
    }
  }
}
