import type { AgentObservationEvent, AgentObservationKind, MeshAgentObservationEvent } from '@monad/protocol';
import type { MeshAgentObservationActivity, MeshAgentObservationProjector } from './agent-adapter.ts';

function kindFromActivity(activity: MeshAgentObservationActivity | undefined): AgentObservationKind | undefined {
  switch (activity) {
    case 'thinking':
      return 'reasoning';
    case 'message':
      return 'assistant-message';
    case 'tool-call':
      return 'tool-call';
    case 'tool-result':
      return 'tool-result';
    case 'user':
      return 'user-message';
    case 'turn-end':
      return 'turn-end';
    case 'system':
      return 'system';
    case 'status':
      return undefined;
    default:
      return undefined;
  }
}

function kindFromRole(event: MeshAgentObservationEvent): AgentObservationKind {
  switch (event.role) {
    case 'agent':
      return 'assistant-message';
    case 'user':
      return 'user-message';
    case 'tool':
      return 'tool-result';
    case 'system':
      return 'system';
  }
}

export function toFallbackAgentObservationEvent(
  event: MeshAgentObservationEvent,
  projector?: Pick<MeshAgentObservationProjector, 'classifyActivity' | 'isStreamingFragment'>
): AgentObservationEvent | null {
  const activity = event.projection === 'unknown' ? undefined : projector?.classifyActivity?.(event);
  if (activity === 'status') return null;
  const kind = event.projection === 'unknown' ? 'unknown' : (kindFromActivity(activity) ?? kindFromRole(event));
  const decoded: AgentObservationEvent = {
    id: event.id,
    ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
    kind,
    streaming: event.projection === 'unknown' ? false : (projector?.isStreamingFragment?.(event) ?? false),
    provenance: { contractEvents: [event] },
    ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}),
    ...(event.createdAt ? { at: event.createdAt } : {})
  };
  if (kind === 'tool-call' || kind === 'tool-result') decoded.tool = { name: 'tool', output: event.text };
  if (kind === 'turn-end') decoded.reason = 'completed';
  if (event.text) decoded.text = event.text;
  return decoded;
}
