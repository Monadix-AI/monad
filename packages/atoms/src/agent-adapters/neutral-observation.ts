import type {
  AgentObservationEvent,
  AgentObservationKind,
  AgentObservationTool,
  MeshAgentObservationEvent
} from '@monad/protocol';
import type { MeshAgentObservationActivity, MeshAgentObservationProjector } from '@monad/sdk-atom';

import { classifyObservationActivity, isStreamingObservationFragment } from './observation-projection.ts';

// Provider start markers. The legacy classifier folds these into `message`/`system` (it never modelled
// turn-start), so the neutral decode detects them here to fill the `turn-start` kind.
const TURN_START_EVENT_TYPES = new Set(['turn/started', 'turn_started', 'turn-start']);
const CONTEXT_COMPACTION_EVENT_TYPES = new Set(['contextCompaction', 'compact_boundary']);

function neutralKindFromActivity(activity: MeshAgentObservationActivity | undefined): AgentObservationKind | undefined {
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

// Providers spell the in-flight state `in_progress`, `inProgress`, `in-progress`, … while consumers
// compare against `running` exactly (see mesh-agent-presence / project-projection). Fold it here so
// no adapter has to remember, and a provider status that already reads `running` passes through.
function normalizedToolStatus(status: string | undefined): string | undefined {
  return status?.replace(/[-_\s]/g, '').toLowerCase() === 'inprogress' ? 'running' : status;
}

// Every adapter normalizes its own tool vocabulary — at projection time on `event.tool`, or through
// the projector's `toolFields` hook when a value only settles after streaming fragments merge. The
// two remaining fallbacks here carry no provider knowledge: a name recovered from the adapter's own
// rendered text, and the rendered text itself standing in for a result with no structured output.
function neutralTool(
  event: MeshAgentObservationEvent,
  kind: 'tool-call' | 'tool-result',
  projector?: Pick<MeshAgentObservationProjector, 'toolFields'>
): AgentObservationTool {
  const declared = { ...(projector?.toolFields?.(event, kind) ?? {}), ...(event.tool ?? {}) };
  const declaredName = declared.name?.toLowerCase() === 'tool' ? undefined : declared.name;
  const name = declaredName ?? projectedToolName(event.text) ?? declared.name ?? 'tool';
  const status = normalizedToolStatus(declared.status);
  const metadata = {
    ...(declared.callId ? { callId: declared.callId } : {}),
    ...(declared.cwd ? { cwd: declared.cwd } : {}),
    ...(status ? { status } : {}),
    ...(declared.exitCode === undefined ? {} : { exitCode: declared.exitCode }),
    ...(declared.durationMs === undefined ? {} : { durationMs: declared.durationMs })
  };
  if (kind === 'tool-call') {
    return declared.input === undefined ? { name, ...metadata } : { name, input: declared.input, ...metadata };
  }
  const output = declared.output ?? event.text;
  return {
    name,
    ...(declared.input === undefined ? {} : { input: declared.input }),
    ...(output === undefined ? {} : { output }),
    ...metadata
  };
}

function projectedToolName(text: string | undefined): string | undefined {
  const value = text?.trim();
  if (!value?.startsWith('Tool call')) return undefined;
  let cursor = 'Tool call'.length;
  if (!isWhitespace(value[cursor])) return undefined;
  while (isWhitespace(value[cursor])) cursor += 1;
  const start = cursor;
  while (cursor < value.length) {
    if (!isWhitespace(value[cursor])) {
      cursor += 1;
      continue;
    }
    const separator = cursor;
    while (isWhitespace(value[cursor])) cursor += 1;
    if (startsToolPayload(value, cursor)) return value.slice(start, separator);
  }
  return value.slice(start) || undefined;
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value);
}

function startsToolPayload(value: string, cursor: number): boolean {
  const first = value[cursor];
  if (first === '{' || first === '[' || first === '"') return true;
  if (first !== undefined && /\d/u.test(first)) return true;
  if (first === '-' && /\d/u.test(value[cursor + 1] ?? '')) return true;
  for (const literal of ['true', 'false', 'null']) {
    if (value.startsWith(literal, cursor) && !/[\p{L}\p{N}_]/u.test(value[cursor + literal.length] ?? '')) return true;
  }
  return false;
}

/**
 * Map an adapter-projected (legacy) observation event to the neutral `AgentObservationEvent`, reusing
 * the adapter's own `classifyActivity`/`isStreamingFragment` so provider vocabulary stays adapter-side.
 * Returns `null` for an event with no neutral representation (a non-terminal system/status notice).
 */
export function toAgentObservationEvent(
  event: MeshAgentObservationEvent,
  projector?: Pick<
    MeshAgentObservationProjector,
    'classifyActivity' | 'isStreamingFragment' | 'toolCategory' | 'toolFields'
  >
): AgentObservationEvent | null {
  if (event.projection === 'unknown') {
    return {
      id: event.id,
      ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
      kind: 'unknown',
      streaming: false,
      text: event.text,
      ...(event.progress ? { progress: event.progress } : {}),
      provenance: { contractEvents: [event] },
      ...(event.createdAt ? { at: event.createdAt } : {})
    };
  }
  const isTurnStart = event.providerEventType !== undefined && TURN_START_EVENT_TYPES.has(event.providerEventType);
  const isContextCompaction =
    event.providerEventType !== undefined && CONTEXT_COMPACTION_EVENT_TYPES.has(event.providerEventType);
  const kind = isTurnStart
    ? 'turn-start'
    : isContextCompaction
      ? 'context-compaction'
      : neutralKindFromActivity(projector?.classifyActivity?.(event) ?? classifyObservationActivity(event));
  if (kind === undefined) return null;

  const event_: AgentObservationEvent = {
    id: event.id,
    ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
    kind,
    streaming: projector?.isStreamingFragment?.(event) ?? isStreamingObservationFragment(event),
    provenance: { contractEvents: [event] }
  };
  if (event.diagnostic !== undefined) event_.diagnostic = event.diagnostic;
  if (event.durationMs !== undefined) event_.durationMs = event.durationMs;
  if (event.hasContent !== undefined) event_.hasContent = event.hasContent;
  if (event.summary !== undefined) event_.summary = event.summary;
  if (event.progress !== undefined) event_.progress = event.progress;
  if (event.createdAt !== undefined) event_.at = event.createdAt;

  if (kind === 'tool-call' || kind === 'tool-result') {
    const tool = neutralTool(event, kind, projector);
    const category = projector?.toolCategory?.(event, tool);
    event_.tool = category ? { ...tool, category } : tool;
    if (event.text) event_.text = event.text;
    return event_;
  }
  if (kind === 'turn-end') {
    event_.reason = event.turnEndReason ?? 'completed';
    // Some providers' terminal event carries the final assistant text (e.g. codex-exec `result`);
    // keep it so a turn-end that doubles as the last message doesn't drop its content.
    if (event.text) event_.text = event.text;
    return event_;
  }
  if (event.text) event_.text = event.text;
  return event_;
}
