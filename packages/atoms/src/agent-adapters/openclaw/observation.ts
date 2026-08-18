import type { MeshAgentObservationEvent } from '@monad/protocol';
import type {
  MeshAgentObservationJsonRecordEntry,
  MeshAgentObservationProjector,
  ObservationRole
} from '../observation-projection.ts';

import {
  classifyObservationActivity,
  isStreamingObservationFragment,
  numberValue,
  observation,
  providerEpochMsTimestamp,
  providerIsoTimestamp,
  rawTextValue,
  recordValue,
  textValue,
  toolCategoryByName,
  turnEndReasonFromStopValue
} from '../observation-projection.ts';

type OpenClawMessageGroup = {
  key: string;
  deltas: string[];
  finalText?: string;
  createdAt?: string;
  raw: Record<string, unknown>[];
};

function openClawCreatedAt(
  record: Record<string, unknown>,
  providerMessage?: Record<string, unknown>
): string | undefined {
  const payload = recordValue(record.payload);
  const data = recordValue(payload?.data);
  return (
    providerIsoTimestamp(
      textValue(record.timestamp, providerMessage?.timestamp, payload?.timestamp, data?.timestamp)
    ) ??
    providerEpochMsTimestamp(
      numberValue(providerMessage?.timestamp, record.timestamp, payload?.timestamp, data?.timestamp)
    )
  );
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
      const item = part as Record<string, unknown>;
      return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .join('');
  return text.trim() ? text : undefined;
}

function recordContent(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const item = recordValue(part);
    return item ? [item] : [];
  });
}

function roleFromOpenClawMessage(record: Record<string, unknown>): ObservationRole {
  const role = textValue(record.role)?.toLowerCase();
  if (role === 'user') return 'user';
  if (role === 'system') return 'system';
  if (role === 'tool' || role === 'toolresult' || role === 'tool_result') return 'tool';
  return 'agent';
}

export function openClawRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): MeshAgentObservationEvent[] {
  const payload = recordValue(record.payload);
  const data = recordValue(payload?.data);
  const createdAt = openClawCreatedAt(record);
  if (record.type === 'event' && record.event === 'agent') {
    const stream = textValue(payload?.stream);
    const phase = textValue(data?.phase);
    if (stream === 'lifecycle' && phase === 'start') {
      return observation({
        id: `${id}:json:${recordIndex}:turn-start`,
        role: 'system',
        text: 'Message started',
        source: 'unknown',
        providerEventType: 'turn-start',
        createdAt,
        raw: record
      });
    }
    if (stream === 'lifecycle' && phase === 'end') {
      return observation({
        id: `${id}:json:${recordIndex}:turn-end`,
        role: 'system',
        text: 'complete',
        source: 'unknown',
        providerEventType: 'turn-end',
        createdAt,
        turnEndReason: turnEndReasonFromStopValue(data?.status, data?.reason, data?.stopReason),
        raw: record
      });
    }
    if (stream === 'reasoning' || stream === 'thinking') {
      return observation({
        id: `${id}:json:${recordIndex}:reasoning`,
        role: 'agent',
        text: typeof data?.delta === 'string' ? data.delta : textValue(data?.text),
        source: 'unknown',
        providerEventType: `${stream}.delta`,
        createdAt,
        raw: record,
        preserveWhitespace: true
      });
    }
    return [];
  }
  const providerMessage = recordValue(record.message) ?? record;
  if (typeof providerMessage.role !== 'string') return [];
  const messageCreatedAt = openClawCreatedAt(record, providerMessage);
  const content = recordContent(providerMessage.content);
  const providerRole = providerMessage.role.toLowerCase();
  if (providerRole === 'toolresult' || providerRole === 'tool_result') {
    return observation({
      id: `${id}:json:${recordIndex}:tool-result`,
      role: 'tool',
      text: textFromContent(providerMessage.content) ?? rawTextValue(providerMessage.text),
      source: 'unknown',
      providerEventType: 'tool_result',
      createdAt: messageCreatedAt,
      tool: {
        ...(textValue(providerMessage.name, providerMessage.toolName)
          ? { name: textValue(providerMessage.name, providerMessage.toolName) }
          : {}),
        ...(textValue(providerMessage.toolCallId) ? { callId: textValue(providerMessage.toolCallId) } : {}),
        ...(providerMessage.content === undefined ? {} : { output: providerMessage.content }),
        status: providerMessage.isError === true ? 'failed' : 'completed'
      },
      raw: providerMessage
    });
  }
  const reasoningText = content
    .map((item) =>
      item.type === 'reasoning' || item.type === 'thinking' ? (textValue(item.text, item.thinking) ?? '') : ''
    )
    .join('');
  const toolCalls = content.flatMap((item, partIndex) => {
    if (item.type !== 'toolCall' && item.type !== 'tool_call') return [];
    const name = textValue(item.name) ?? 'tool';
    const input = item.arguments ?? item.input;
    return observation({
      id: `${id}:json:${recordIndex}:tool-call:${partIndex}`,
      role: 'tool',
      text: `Tool call ${name}${input === undefined ? '' : ` ${JSON.stringify(input)}`}`,
      source: 'unknown',
      providerEventType: 'tool_call',
      createdAt: messageCreatedAt,
      tool: {
        name,
        ...(textValue(item.toolCallId, item.id) ? { callId: textValue(item.toolCallId, item.id) } : {}),
        ...(input === undefined ? {} : { input })
      },
      raw: item
    });
  });
  const reasoning = observation({
    id: `${id}:json:${recordIndex}:reasoning`,
    role: 'agent',
    text: reasoningText,
    source: 'unknown',
    providerEventType: 'reasoning',
    createdAt: messageCreatedAt,
    raw: record
  });
  const message = observation({
    id: `${id}:json:${recordIndex}:message`,
    role: roleFromOpenClawMessage(providerMessage),
    text: textFromContent(providerMessage.content) ?? textValue(providerMessage.text),
    source: 'unknown',
    providerEventType: 'message',
    createdAt: messageCreatedAt,
    raw: record
  });
  return [...reasoning, ...toolCalls, ...message];
}

function openClawMessageGroup(
  record: Record<string, unknown>
): { key: string; state: OpenClawMessageGroup } | undefined {
  if (record.type !== 'event' || record.event !== 'chat') return undefined;
  const payload = recordValue(record.payload);
  const key = textValue(payload?.runId);
  if (!key) return undefined;
  return { key, state: { key, deltas: [], raw: [] } };
}

export const openClawObservationProjection = {
  classifyActivity: classifyObservationActivity,
  toolCategory: toolCategoryByName('shell', ['exec', 'shell']),
  eventEntries: (entries: MeshAgentObservationJsonRecordEntry[], context?: { providerSessionRef?: string }) =>
    entries.filter(({ record }) => {
      if (typeof record.role === 'string' || typeof recordValue(record.message)?.role === 'string') return true;
      if (record.type !== 'event') return record.type !== 'res' && record.type !== 'req';
      const payload = recordValue(record.payload);
      const sessionKey = textValue(payload?.sessionKey);
      if (context?.providerSessionRef && sessionKey && sessionKey !== context.providerSessionRef) return false;
      if (record.event === 'chat') return payload?.state === 'delta' || payload?.state === 'final';
      if (record.event !== 'agent') {
        return (
          record.event !== 'connect.challenge' &&
          record.event !== 'health' &&
          record.event !== 'presence' &&
          record.event !== 'tick'
        );
      }
      const stream = textValue(payload?.stream);
      const phase = textValue(recordValue(payload?.data)?.phase);
      if (
        (stream === 'lifecycle' && (phase === 'start' || phase === 'end')) ||
        stream === 'reasoning' ||
        stream === 'thinking'
      )
        return true;
      return stream !== 'assistant' && stream !== 'lifecycle' && stream !== 'item';
    }),
  isStreamingFragment: isStreamingObservationFragment,
  messageGroup: {
    append(group, entry) {
      const state = group as OpenClawMessageGroup;
      const payload = recordValue(entry.record.payload);
      state.raw.push(entry.record);
      state.createdAt = openClawCreatedAt(entry.record, recordValue(payload?.message)) ?? state.createdAt;
      if (payload?.state === 'delta' && typeof payload.deltaText === 'string') state.deltas.push(payload.deltaText);
      if (payload?.state === 'final') {
        const message = recordValue(payload.message);
        state.finalText = textFromContent(message?.content);
      }
    },
    create(record) {
      return openClawMessageGroup(record);
    },
    render(id, group) {
      const state = group as OpenClawMessageGroup;
      return observation({
        id: `${id}:chat:${state.key}:message`,
        role: 'agent',
        text: state.finalText ?? state.deltas.join(''),
        source: 'unknown',
        providerEventType: state.finalText === undefined ? 'message.delta' : 'message',
        createdAt: state.createdAt,
        rawEvents: state.raw,
        preserveWhitespace: true
      });
    }
  },
  recordProjectors: [{ parse: ({ id, record, recordIndex }) => openClawRecordEvents(id, record, recordIndex) }]
} satisfies MeshAgentObservationProjector;
