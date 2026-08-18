import type { MeshAgentObservationEvent } from '@monad/protocol';
import type { MeshAgentObservationProjector, ObservationRole } from '../observation-projection.ts';

import {
  classifyObservationActivity,
  compactJson,
  isStreamingObservationFragment,
  numberValue,
  observation,
  providerEpochSecondsTimestamp,
  providerIsoTimestamp,
  rawTextValue,
  recordValue,
  textValue,
  toolCategoryByName,
  turnEndReasonFromStopValue
} from '../observation-projection.ts';

function roleFromHermesMessage(record: Record<string, unknown>): ObservationRole {
  const role = textValue(record.role)?.toLowerCase();
  if (role === 'user') return 'user';
  if (role === 'system') return 'system';
  if (role === 'tool' || role === 'tool_result' || role === 'toolresult') return 'tool';
  return 'agent';
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
      const item = part as Record<string, unknown>;
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      return '';
    })
    .join('');
  return text.trim() ? text : undefined;
}

function hermesCreatedAt(record: Record<string, unknown>): string | undefined {
  const params = recordValue(record.params);
  const payload = recordValue(params?.payload);
  return (
    providerIsoTimestamp(textValue(record.timestamp, params?.timestamp, payload?.timestamp)) ??
    providerEpochSecondsTimestamp(numberValue(record.timestamp, params?.timestamp, payload?.timestamp))
  );
}

function hermesRecordIdentity(record: Record<string, unknown>, recordIndex: number): string {
  return textValue(record.id) ?? numberValue(record.id)?.toString() ?? `index-${recordIndex}`;
}

function toolCallEvents(
  id: string,
  record: Record<string, unknown>,
  recordIdentity: string,
  createdAt: string | undefined
): MeshAgentObservationEvent[] {
  const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
  return calls.flatMap((call, callIndex) => {
    if (!call || typeof call !== 'object' || Array.isArray(call)) return [];
    const item = call as Record<string, unknown>;
    const fn = item.function && typeof item.function === 'object' ? (item.function as Record<string, unknown>) : {};
    const name = textValue(item.name, item.tool_name, fn.name) ?? 'tool';
    const args = item.input ?? item.args ?? item.arguments ?? fn.arguments;
    const callId = textValue(item.id, item.call_id, item.tool_call_id);
    const argsText = args === undefined ? '' : ` ${compactJson(args) ?? String(args)}`;
    return observation({
      id: `${id}:json:${recordIdentity}:tool-call:${callIndex}`,
      role: 'tool',
      text: `Tool call ${name}${argsText}`,
      source: 'unknown',
      providerEventType: 'tool_call',
      createdAt,
      tool: { name, ...(callId ? { callId } : {}), ...(args === undefined ? {} : { input: args }) },
      rawEvents: [{ ...item, name, arguments: args, tool_call_id: callId }, record]
    });
  });
}

function gatewayToolEvent(
  id: string,
  record: Record<string, unknown>,
  recordIdentity: string,
  eventType: 'tool.start' | 'tool.complete',
  createdAt: string | undefined
): MeshAgentObservationEvent[] {
  const params = recordValue(record.params);
  const payload = recordValue(params?.payload) ?? {};
  const name = textValue(payload.name) ?? 'tool';
  const callId = textValue(payload.tool_id, payload.tool_call_id);
  const input = payload.args ?? payload.context;
  const output = payload.result ?? payload.result_text ?? payload.summary;
  const durationS = numberValue(payload.duration_s);
  const detail = eventType === 'tool.start' ? input : output;
  return observation({
    id: `${id}:json:${recordIdentity}:${eventType}`,
    role: 'tool',
    text: `${eventType === 'tool.start' ? 'Tool call' : 'Tool result'} ${name}${
      detail === undefined ? '' : ` ${compactJson(detail) ?? String(detail)}`
    }`,
    source: 'unknown',
    providerEventType: eventType === 'tool.start' ? 'tool_call' : 'tool_result',
    createdAt,
    tool: {
      name,
      ...(callId ? { callId } : {}),
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output }),
      ...(durationS === undefined ? {} : { durationMs: Math.round(durationS * 1000) }),
      status: eventType === 'tool.start' ? 'running' : 'completed'
    },
    rawEvents: [{ ...payload, ...(callId ? { tool_call_id: callId } : {}) }, record]
  });
}

export function hermesRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): MeshAgentObservationEvent[] {
  const params = recordValue(record.params);
  const payload = recordValue(params?.payload);
  const eventType = textValue(params?.type);
  const createdAt = hermesCreatedAt(record);
  const recordIdentity = hermesRecordIdentity(record, recordIndex);
  if (record.method === 'event' && eventType) {
    const text = typeof payload?.text === 'string' ? payload.text : undefined;
    switch (eventType) {
      case 'message.start':
        return observation({
          id: `${id}:json:${recordIdentity}:turn-start`,
          role: 'system',
          text: 'Message started',
          source: 'unknown',
          providerEventType: 'turn-start',
          createdAt,
          raw: record
        });
      case 'reasoning.delta':
        return observation({
          id: `${id}:json:${recordIdentity}:reasoning`,
          role: 'agent',
          text,
          source: 'unknown',
          providerEventType: 'reasoning.delta',
          createdAt,
          raw: record,
          preserveWhitespace: true
        });
      case 'message.delta':
        return observation({
          id: `${id}:json:${recordIdentity}:message`,
          role: 'agent',
          text,
          source: 'unknown',
          providerEventType: 'message.delta',
          createdAt,
          raw: record,
          preserveWhitespace: true
        });
      case 'tool.start':
      case 'tool.complete':
        return gatewayToolEvent(id, record, recordIdentity, eventType, createdAt);
      case 'message.complete':
        return observation({
          id: `${id}:json:${recordIdentity}:turn-end`,
          role: 'system',
          text: textValue(payload?.status) ?? 'complete',
          source: 'unknown',
          providerEventType: 'turn-end',
          createdAt,
          turnEndReason: turnEndReasonFromStopValue(payload?.status, payload?.reason, payload?.stop_reason),
          raw: record
        });
      default:
        return [];
    }
  }
  if (typeof record.role !== 'string') return [];

  const reasoningText = textValue(record.reasoning_content, record.reasoning);
  const reasoning = observation({
    id: `${id}:json:${recordIdentity}:reasoning`,
    role: 'agent',
    text: reasoningText,
    source: 'unknown',
    providerEventType: 'reasoning',
    createdAt,
    raw: record
  });
  const contentRole = roleFromHermesMessage(record);
  const contentText =
    textFromContent(record.content) ??
    (contentRole === 'tool' ? rawTextValue(record.text) : textValue(record.text, record.tool_name));
  const content = observation({
    id: `${id}:json:${recordIdentity}:message`,
    role: contentRole,
    text: contentText,
    source: 'unknown',
    providerEventType: record.role === 'tool' ? 'tool_result' : 'message',
    createdAt,
    ...(contentRole === 'tool'
      ? {
          tool: {
            ...(textValue(record.tool_name) ? { name: textValue(record.tool_name) } : {}),
            ...(textValue(record.tool_call_id, record.toolCallId)
              ? { callId: textValue(record.tool_call_id, record.toolCallId) }
              : {})
          }
        }
      : {}),
    raw: record
  });
  return [...reasoning, ...content, ...toolCallEvents(id, record, recordIdentity, createdAt)];
}

export const hermesObservationProjection = {
  classifyActivity: classifyObservationActivity,
  dedupeIdentity: (event) => {
    const rawRecords = event.provenance.rawEvents
      .map((raw) => recordValue(raw))
      .filter((raw): raw is Record<string, unknown> => raw !== undefined);
    const callId = rawRecords.map((raw) => textValue(raw.tool_call_id, raw.tool_id)).find(Boolean);
    if (callId) return callId;
    return rawRecords.some((raw) => raw.method === 'event') ? event.id : undefined;
  },
  toolCategory: toolCategoryByName('shell', ['terminal', 'shell', 'bash', 'exec']),
  eventEntries: (entries) =>
    entries.filter(({ record }) => {
      if (typeof record.role === 'string') return true;
      const params = recordValue(record.params);
      const type = textValue(params?.type);
      if (record.method !== 'event') return record.method !== undefined;
      if (
        type === 'message.start' ||
        type === 'reasoning.delta' ||
        type === 'message.delta' ||
        type === 'message.complete'
      )
        return true;
      return (
        type !== 'gateway.ready' &&
        type !== 'session.info' &&
        type !== 'thinking.delta' &&
        type !== 'reasoning.available' &&
        type !== 'session.title'
      );
    }),
  isStreamingFragment: isStreamingObservationFragment,
  recordProjectors: [{ parse: ({ id, record, recordIndex }) => hermesRecordEvents(id, record, recordIndex) }]
} satisfies MeshAgentObservationProjector;
