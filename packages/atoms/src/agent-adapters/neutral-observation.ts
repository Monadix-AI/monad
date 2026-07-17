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
    case 'system':
      return 'system';
    case 'status':
      return undefined;
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
  const item = recordValue(params?.item) ?? recordValue(raw?.item);
  const message = recordValue(raw?.message);
  const content = Array.isArray(message?.content) ? message.content : Array.isArray(raw?.content) ? raw.content : [];
  const toolUse = content.find(
    (part) =>
      part && typeof part === 'object' && !Array.isArray(part) && (part as Record<string, unknown>).type === 'tool_use'
  ) as Record<string, unknown> | undefined;
  const name =
    textValue(
      toolUse?.name,
      item?.tool,
      item?.name,
      item?.type === 'commandExecution' ? item.type : undefined,
      raw?.name,
      raw?.tool,
      raw?.tool_name,
      params?.name,
      params?.tool
    ) ?? 'tool';
  const metadata = {
    ...(textValue(item?.cwd) ? { cwd: textValue(item?.cwd) } : {}),
    ...(textValue(item?.status) ? { status: textValue(item?.status) } : {}),
    ...(typeof item?.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
    ...(typeof item?.durationMs === 'number' ? { durationMs: item.durationMs } : {})
  };
  const input =
    toolUse?.input ?? item?.input ?? item?.command ?? raw?.input ?? raw?.args ?? raw?.arguments ?? params?.input;
  if (kind === 'tool-call') {
    return input === undefined ? { name, ...metadata } : { name, input, ...metadata };
  }
  const output =
    item?.aggregatedOutput ??
    item?.output ??
    item?.result ??
    raw?.output ??
    raw?.result ??
    raw?.content ??
    params?.output ??
    event.text;
  return {
    name,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...metadata
  };
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
  if (event.projection === 'unknown') {
    return {
      id: event.id,
      ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
      kind: 'unknown',
      streaming: false,
      text: event.text,
      ...(event.raw !== undefined ? { raw: event.raw } : {}),
      ...(event.createdAt ? { at: event.createdAt } : {})
    };
  }
  const isTurnStart = event.providerEventType !== undefined && TURN_START_EVENT_TYPES.has(event.providerEventType);
  const kind = isTurnStart
    ? 'turn-start'
    : neutralKindFromActivity(projector?.classifyActivity?.(event) ?? classifyObservationActivity(event));
  if (kind === undefined) return null;

  const event_: AgentObservationEvent = {
    id: event.id,
    ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
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
    // Some providers' terminal event carries the final assistant text (e.g. codex-exec `result`);
    // keep it so a turn-end that doubles as the last message doesn't drop its content.
    if (event.text) event_.text = event.text;
    return event_;
  }
  if (event.text) event_.text = event.text;
  return event_;
}
