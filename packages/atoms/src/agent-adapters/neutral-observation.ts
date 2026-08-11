import type {
  AgentObservationEvent,
  AgentObservationKind,
  AgentObservationTool,
  AgentObservationTurnEndReason,
  MeshAgentObservationEvent
} from '@monad/protocol';
import type { MeshAgentObservationActivity, MeshAgentObservationProjector } from '@monad/sdk-atom';

import {
  classifyObservationActivity,
  isStreamingObservationFragment,
  recordValue,
  textValue
} from './observation-projection.ts';
import { parseStreamingJson } from './partial-json.ts';

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

function turnEndReason(event: MeshAgentObservationEvent): AgentObservationTurnEndReason {
  if (event.providerEventType === 'error' || event.providerEventType === 'server_error') return 'error';
  const raw = recordValue(event.provenance.rawEvents[0]);
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

/** A raw slice that IS the provider item (as history pages project it) rather than the JSON-RPC
 *  envelope wrapping one (as live notifications deliver it): its declared id sits at the top level. */
function isBareProviderItem(raw: Record<string, unknown> | undefined): raw is Record<string, unknown> & { id: string } {
  return typeof raw?.id === 'string' && typeof raw.type === 'string' && raw.method === undefined;
}

// Best-effort structured tool extraction across provider raw shapes. The adapter's record projector
// already normalized the human `text`; here we surface the machine fields a neutral renderer needs.
function neutralTool(event: MeshAgentObservationEvent, kind: 'tool-call' | 'tool-result'): AgentObservationTool {
  const rawRecords = event.provenance.rawEvents
    .map((value) => recordValue(value))
    .filter((value): value is Record<string, unknown> => value !== undefined);
  const raw = rawRecords[0];
  const params = recordValue(raw?.params);
  const sourceEvent = recordValue(params?.event);
  const sourcePayload = recordValue(sourceEvent?.payload);
  const item = recordValue(params?.item) ?? recordValue(raw?.item) ?? rawRecords.find(isBareProviderItem);
  const itemResult = recordValue(item?.result);
  const content = rawRecords.flatMap((record) => {
    const message = recordValue(record.message);
    return Array.isArray(message?.content) ? message.content : Array.isArray(record.content) ? record.content : [];
  });
  const transcriptToolUse = content.findLast(
    (part) =>
      part && typeof part === 'object' && !Array.isArray(part) && (part as Record<string, unknown>).type === 'tool_use'
  ) as Record<string, unknown> | undefined;
  const toolResult = content.find(
    (part) =>
      part &&
      typeof part === 'object' &&
      !Array.isArray(part) &&
      (part as Record<string, unknown>).type === 'tool_result'
  ) as Record<string, unknown> | undefined;
  const streamToolUse = rawRecords
    .map((record) => recordValue(recordValue(record.event)?.content_block))
    .find((block) => block?.type === 'tool_use');
  const toolUse = transcriptToolUse ?? streamToolUse;
  const partialInputJson = rawRecords
    .map((record) => recordValue(recordValue(record.event)?.delta)?.partial_json)
    .filter((value): value is string => typeof value === 'string')
    .join('');
  const partialInput = partialInputJson ? parseStreamingJson(partialInputJson) : undefined;
  const declaredName = textValue(
    toolUse?.name,
    item?.tool,
    item?.name,
    raw?.name,
    raw?.tool,
    raw?.toolName,
    raw?.tool_name,
    params?.name,
    params?.tool,
    sourcePayload?.tool
  );
  const projectedName = projectedToolName(event.text);
  const name =
    (declaredName?.toLowerCase() === 'tool' ? undefined : declaredName) ??
    textValue(
      item?.type === 'commandExecution' ? item.type : undefined,
      item?.type === 'command_execution' ? item.type : undefined,
      item?.type === 'imageGeneration' ? item.type : undefined
    ) ??
    projectedName ??
    declaredName ??
    'tool';
  const callId = textValue(
    toolUse?.id,
    toolResult?.tool_use_id,
    item?.id,
    item?.callId,
    item?.call_id,
    raw?.callId,
    raw?.toolCallId,
    raw?.call_id,
    raw?.tool_call_id,
    raw?.tool_use_id,
    // Both delivery windows must yield the same id, or a call read back from a history page won't
    // pair with the result that arrived live.
    isBareProviderItem(raw) ? raw.id : undefined,
    params?.callId,
    params?.call_id,
    params?.itemId,
    sourcePayload?.toolCallId
  );
  const sourceStatus =
    sourceEvent?.type === 'tool.called'
      ? 'running'
      : sourceEvent?.type === 'tool.progress'
        ? 'running'
        : sourceEvent?.type === 'tool.result'
          ? sourcePayload?.ok === false
            ? 'failed'
            : 'completed'
          : undefined;
  const lifecycleMethod = rawRecords.map((record) => textValue(record.method)).find((method) => method !== undefined);
  const lifecycleStatus =
    lifecycleMethod === 'item/started' ? 'running' : lifecycleMethod === 'item/completed' ? 'completed' : undefined;
  const providerStatus = textValue(item?.status, raw?.status, params?.status, sourceStatus, lifecycleStatus);
  const explicitStatus =
    providerStatus?.replace(/[-_\s]/g, '').toLowerCase() === 'inprogress' ? 'running' : providerStatus;
  const claudeResultStatus =
    kind === 'tool-result' &&
    (toolResult !== undefined || (event.source === 'claude-code-sdk' && raw?.type === 'tool_result'))
      ? toolResult?.is_error === true || raw?.is_error === true
        ? 'failed'
        : 'completed'
      : undefined;
  const openClawResultStatus =
    kind === 'tool-result' && typeof raw?.toolCallId === 'string'
      ? raw.isError === true
        ? 'failed'
        : 'completed'
      : undefined;
  const metadata = {
    ...(callId ? { callId } : {}),
    ...(textValue(item?.cwd) ? { cwd: textValue(item?.cwd) } : {}),
    ...((explicitStatus ?? claudeResultStatus ?? openClawResultStatus)
      ? { status: explicitStatus ?? claudeResultStatus ?? openClawResultStatus }
      : {}),
    ...(typeof item?.exitCode === 'number'
      ? { exitCode: item.exitCode }
      : typeof item?.exit_code === 'number'
        ? { exitCode: item.exit_code }
        : {}),
    ...(typeof item?.durationMs === 'number'
      ? { durationMs: item.durationMs }
      : typeof item?.duration_ms === 'number'
        ? { durationMs: item.duration_ms }
        : typeof itemResult?.durationMs === 'number'
          ? { durationMs: itemResult.durationMs }
          : typeof itemResult?.duration_ms === 'number'
            ? { durationMs: itemResult.duration_ms }
            : {})
  };
  const input =
    transcriptToolUse?.input ??
    partialInput ??
    streamToolUse?.input ??
    item?.input ??
    item?.arguments ??
    item?.action ??
    item?.command ??
    item?.path ??
    item?.revisedPrompt ??
    raw?.input ??
    raw?.args ??
    raw?.arguments ??
    params?.input ??
    sourcePayload?.input;
  if (kind === 'tool-call') {
    return input === undefined ? { name, ...metadata } : { name, input, ...metadata };
  }
  const imageOutput =
    textValue(item?.type)?.toLowerCase() === 'imagegeneration'
      ? textValue(item?.savedPath, item?.saved_path)
      : undefined;
  const output =
    imageOutput ??
    item?.aggregatedOutput ??
    item?.aggregated_output ??
    item?.output ??
    item?.result ??
    item?.results ??
    raw?.output ??
    raw?.result ??
    raw?.content ??
    params?.output ??
    sourcePayload?.displayResult ??
    sourcePayload?.result ??
    sourcePayload?.output ??
    event.text;
  return {
    name,
    ...(input === undefined ? {} : { input }),
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
  projector?: Pick<MeshAgentObservationProjector, 'classifyActivity' | 'isStreamingFragment' | 'toolCategory'>
): AgentObservationEvent | null {
  if (event.projection === 'unknown') {
    return {
      id: event.id,
      ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
      kind: 'unknown',
      streaming: false,
      text: event.text,
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
  if (event.createdAt !== undefined) event_.at = event.createdAt;

  if (kind === 'tool-call' || kind === 'tool-result') {
    const tool = neutralTool(event, kind);
    const category = projector?.toolCategory?.(event, tool);
    event_.tool = category ? { ...tool, category } : tool;
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
