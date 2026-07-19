import type { AgentObservationEvent, AgentObservationTurnEndReason, Event } from '@monad/protocol';

import { messageProducerSchema, parseEventPayload } from '@monad/protocol';

/** Maps monad's own agent-loop domain events (the daemon's session `Event` log — see
 *  `docs/proposals/agent-adapter-observation-layering.md`'s "session raw = domain events" decision) to
 *  the agent-kind-neutral `AgentObservationEvent` plane mesh-agent adapters already produce via
 *  `toAgentObservationEvent` in `@monad/atoms`. Unlike an external adapter, monad's own events are
 *  already structured (no raw-text decode needed) — this is a field reshape, not a parser. */
export function toAgentObservationEvent(event: Event): AgentObservationEvent | null {
  const base = { id: event.id, at: event.at, provenance: { contractEvents: [event] as [Event] } };
  switch (event.type) {
    case 'session.message.created': {
      const { message } = parseEventPayload('session.message.created', event.payload);
      // Only the user's settled prompt maps here; a streaming agent message surfaces through its
      // delta.appended fragments and the terminal completed/failed event, not its creation.
      if (message.role !== 'user' || message.stream.status !== 'settled') return null;
      return { ...base, kind: 'user-message', streaming: false, text: message.text };
    }
    case 'session.message.delta.appended': {
      const { channel, delta } = parseEventPayload('session.message.delta.appended', event.payload);
      return {
        ...base,
        kind: channel === 'reasoning' ? 'reasoning' : 'assistant-message',
        streaming: true,
        text: delta
      };
    }
    case 'session.message.completed': {
      const { message } = parseEventPayload('session.message.completed', event.payload);
      return { ...base, kind: 'assistant-message', streaming: false, text: message.text };
    }
    case 'session.message.failed': {
      const { message } = parseEventPayload('session.message.failed', event.payload);
      return { ...base, kind: 'turn-end', streaming: false, reason: 'error', text: message.text };
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
    case 'session.run.started':
      return { ...base, kind: 'turn-start', streaming: false };
    case 'session.run.completed':
      return { ...base, kind: 'turn-end', streaming: false, reason: 'completed' as AgentObservationTurnEndReason };
    case 'session.run.cancelled':
      return { ...base, kind: 'turn-end', streaming: false, reason: 'cancelled' as AgentObservationTurnEndReason };
    case 'session.run.failed': {
      const payload = parseEventPayload('session.run.failed', event.payload);
      return { ...base, kind: 'turn-end', streaming: false, reason: 'error', text: payload.error.message };
    }
    default:
      return null;
  }
}

/** Whether a domain event belongs to the session's own `monad`-typed member, vs. another member's
 *  activity relayed into the same session log. Canonical `session.message.*` events carry an explicit
 *  `producer: MessageProducer` — a bridged member is `kind: 'mesh-agent'` (or an `agent` bound to an
 *  `meshSessionId`), so those are excluded by the parsed producer. Non-message domain events
 *  (`tool.*`, `session.run.*`) carry no producer; a bridged member still tags those with a top-level
 *  `meshSessionId`/`deliveryId`. */
export function isMonadAgentDomainEvent(event: Event): boolean {
  const rawProducer = (event.payload as { producer?: unknown }).producer;
  if (rawProducer !== undefined) {
    const parsed = messageProducerSchema.safeParse(rawProducer);
    if (parsed.success) {
      const { data: producer } = parsed;
      if (producer.kind === 'mesh-agent') return false;
      return !(producer.kind === 'agent' && producer.meshSessionId !== undefined);
    }
  }
  const payload = event.payload as { meshSessionId?: unknown; deliveryId?: unknown };
  return typeof payload.meshSessionId !== 'string' && typeof payload.deliveryId !== 'string';
}
