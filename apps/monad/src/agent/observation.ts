import type { AgentObservationEvent, AgentObservationTurnEndReason, Event } from '@monad/protocol';

import { parseEventPayload } from '@monad/protocol';

/** Maps monad's own agent-loop domain events (the daemon's session `Event` log — see
 *  `docs/proposals/agent-adapter-observation-layering.md`'s "session raw = domain events" decision) to
 *  the agent-kind-neutral `AgentObservationEvent` plane external-agent adapters already produce via
 *  `toAgentObservationEvent` in `@monad/atoms`. Unlike an external adapter, monad's own events are
 *  already structured (no raw-text decode needed) — this is a field reshape, not a parser. */
export function toAgentObservationEvent(event: Event): AgentObservationEvent | null {
  const base = { id: event.id, at: event.at, provenance: { contractEvents: [event] as [Event] } };
  switch (event.type) {
    case 'user.message': {
      const payload = parseEventPayload('user.message', event.payload);
      return { ...base, kind: 'user-message', streaming: false, text: payload.text };
    }
    case 'agent.token': {
      const payload = parseEventPayload('agent.token', event.payload);
      return { ...base, kind: 'assistant-message', streaming: true, text: payload.delta };
    }
    case 'agent.reasoning': {
      const payload = parseEventPayload('agent.reasoning', event.payload);
      return { ...base, kind: 'reasoning', streaming: true, text: payload.delta };
    }
    case 'agent.message': {
      const payload = parseEventPayload('agent.message', event.payload);
      return { ...base, kind: 'assistant-message', streaming: false, text: payload.text };
    }
    case 'agent.error': {
      const payload = parseEventPayload('agent.error', event.payload);
      return { ...base, kind: 'turn-end', streaming: false, reason: 'error', text: payload.message };
    }
    case 'tool.called': {
      const payload = parseEventPayload('tool.called', event.payload);
      return {
        ...base,
        kind: 'tool-call',
        streaming: false,
        tool: { name: payload.tool, input: payload.input }
      };
    }
    case 'tool.progress': {
      const payload = parseEventPayload('tool.progress', event.payload);
      return {
        ...base,
        kind: 'tool-result',
        streaming: true,
        tool: { name: payload.tool, output: payload.output }
      };
    }
    case 'tool.result': {
      const payload = parseEventPayload('tool.result', event.payload);
      return {
        ...base,
        kind: 'tool-result',
        streaming: false,
        tool: { name: payload.tool, output: payload.displayResult ?? payload.result }
      };
    }
    // Publish-only turn-boundary markers (never persisted — see `emitStreamMarker` in
    // `handlers/session/context.ts`), carried on the same bus as durable events.
    case 'session.stream_started':
      return { ...base, kind: 'turn-start', streaming: false };
    case 'session.stream_ended':
      return { ...base, kind: 'turn-end', streaming: false, reason: 'completed' as AgentObservationTurnEndReason };
    default:
      return null;
  }
}

/** Whether a domain event belongs to the session's own `monad`-typed member, vs. another member's
 *  activity relayed into the same session log (a managed external-agent member's `agent.token` /
 *  `agent.message` are bridged into the transcript carrying `externalAgentSessionId`/`deliveryId`).
 *  ACP-delegated tool events (`forward-acp.ts`, `acp-channel-delegation.ts`) are not yet distinguishable
 *  this way — generalizing observation to ACP agents is left for a follow-up (see the implementation-
 *  order proposal's P5 deviations). */
export function isMonadAgentDomainEvent(event: Event): boolean {
  const payload = event.payload as { externalAgentSessionId?: unknown; deliveryId?: unknown };
  return typeof payload.externalAgentSessionId !== 'string' && typeof payload.deliveryId !== 'string';
}
