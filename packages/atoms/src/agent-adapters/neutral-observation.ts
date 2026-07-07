import type {
  AgentObservationEvent,
  AgentObservationKind,
  AgentObservationTool,
  AgentObservationTurnEndReason,
  ExternalAgentObservationEvent
} from '@monad/protocol';
import type { ExternalAgentObservationActivity, ExternalAgentObservationProjector } from '@monad/sdk-atom';

import {
  classifyObservationActivity,
  isStreamingObservationFragment,
  recordValue,
  textValue
} from './observation-projection.ts';

// Provider start markers. The legacy classifier folds these into `message`/`system` (it never modelled
// turn-start), so the neutral decode detects them here to fill the `turn-start` kind.
const TURN_START_EVENT_TYPES = new Set(['turn/started', 'turn_started', 'turn-start']);

// Only the kinds a neutral consumer renders. `system` (a non-terminal status notice) has no neutral
// representation — generating state is derived elsewhere — so it maps to `undefined` and is dropped.
function neutralKindFromActivity(
  activity: ExternalAgentObservationActivity | undefined
): AgentObservationKind | undefined {
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
    default:
      return undefined;
  }
}

function turnEndReason(event: ExternalAgentObservationEvent): AgentObservationTurnEndReason {
  if (event.providerEventType === 'error' || event.providerEventType === 'server_error') return 'error';
  const raw = recordValue(event.raw);
  if (raw?.is_error === true) return 'error';
  switch (textValue(raw?.subtype, raw?.stop_reason, recordValue(raw?.params)?.reason)) {
    case 'error':
      return 'error';
    case 'aborted':
    case 'cancelled':
    case 'canceled':
    case 'interrupted':
      return 'aborted';
    case 'max_tokens':
    case 'length':
      return 'length';
    case 'content_filter':
    case 'content-filter':
      return 'content-filter';
    default:
      return 'completed';
  }
}

// Best-effort structured tool extraction across provider raw shapes. The adapter's record projector
// already normalized the human `text`; here we surface the machine fields a neutral renderer needs.
function neutralTool(event: ExternalAgentObservationEvent, kind: 'tool-call' | 'tool-result'): AgentObservationTool {
  const raw = recordValue(event.raw);
  const params = recordValue(raw?.params);
  const name = textValue(raw?.name, raw?.tool, raw?.tool_name, params?.name, params?.tool) ?? 'tool';
  if (kind === 'tool-call') {
    const input = raw?.input ?? raw?.args ?? raw?.arguments ?? params?.input;
    return input === undefined ? { name } : { name, input };
  }
  const output = raw?.output ?? raw?.result ?? raw?.content ?? params?.output ?? event.text;
  return output === undefined ? { name } : { name, output };
}

/**
 * Map an adapter-projected (legacy) observation event to the neutral `AgentObservationEvent`, reusing
 * the adapter's own `classifyActivity`/`isStreamingFragment` so provider vocabulary stays adapter-side.
 * Returns `null` for an event with no neutral representation (a non-terminal system/status notice).
 */
export function toAgentObservationEvent(
  event: ExternalAgentObservationEvent,
  projector?: Pick<ExternalAgentObservationProjector, 'classifyActivity' | 'isStreamingFragment'>
): AgentObservationEvent | null {
  const isTurnStart = event.providerEventType !== undefined && TURN_START_EVENT_TYPES.has(event.providerEventType);
  const kind = isTurnStart
    ? 'turn-start'
    : neutralKindFromActivity(projector?.classifyActivity?.(event) ?? classifyObservationActivity(event));
  if (kind === undefined) return null;

  const event_: AgentObservationEvent = {
    id: event.id,
    kind,
    streaming: projector?.isStreamingFragment?.(event) ?? isStreamingObservationFragment(event)
  };
  if (event.raw !== undefined) event_.raw = event.raw;
  if (event.createdAt !== undefined) event_.at = event.createdAt;

  if (kind === 'tool-call' || kind === 'tool-result') {
    event_.tool = neutralTool(event, kind);
    if (event.text) event_.text = event.text;
    return event_;
  }
  if (kind === 'turn-end') {
    event_.reason = turnEndReason(event);
    return event_;
  }
  if (event.text) event_.text = event.text;
  return event_;
}
