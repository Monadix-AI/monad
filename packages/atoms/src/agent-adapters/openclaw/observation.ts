import type { MeshAgentObservationEvent } from '@monad/protocol';
import type {
  MeshAgentObservationJsonRecordEntry,
  MeshAgentObservationProjector,
  ObservationRole
} from '../observation-projection.ts';

import {
  classifyObservationActivity,
  isStreamingObservationFragment,
  observation,
  recordValue,
  textValue
} from '../observation-projection.ts';

type OpenClawMessageGroup = {
  key: string;
  deltas: string[];
  finalText?: string;
  raw: Record<string, unknown>[];
};

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
        raw: record,
        preserveWhitespace: true
      });
    }
    return [];
  }
  const providerMessage = recordValue(record.message) ?? record;
  if (typeof providerMessage.role !== 'string') return [];
  const reasoningText = Array.isArray(providerMessage.content)
    ? providerMessage.content
        .map((part) => {
          const item = recordValue(part);
          return item?.type === 'reasoning' || item?.type === 'thinking'
            ? (textValue(item.text, item.thinking) ?? '')
            : '';
        })
        .join('')
    : undefined;
  const reasoning = observation({
    id: `${id}:json:${recordIndex}:reasoning`,
    role: 'agent',
    text: reasoningText,
    source: 'unknown',
    providerEventType: 'reasoning',
    raw: record
  });
  const message = observation({
    id: `${id}:json:${recordIndex}:message`,
    role: roleFromOpenClawMessage(providerMessage),
    text: textFromContent(providerMessage.content) ?? textValue(providerMessage.text),
    source: 'unknown',
    providerEventType: 'message',
    raw: record
  });
  return [...reasoning, ...message];
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
        rawEvents: state.raw,
        preserveWhitespace: true
      });
    }
  },
  recordProjectors: [{ parse: ({ id, record, recordIndex }) => openClawRecordEvents(id, record, recordIndex) }]
} satisfies MeshAgentObservationProjector;
