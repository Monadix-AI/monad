import type { AgentObservationEvent, MeshAgentObservationEvent } from '@monad/protocol';
import type {
  MeshAgentObservationJsonRecordEntry,
  MeshAgentObservationProjector,
  MeshAgentObservationToolRun,
  ObservationRole
} from '../shared/observation/observation-projection.ts';

import {
  classifyObservationActivity,
  isStreamingObservationFragment,
  normalizedMcpToolOutput,
  numberValue,
  observation,
  providerEpochMsTimestamp,
  providerIsoTimestamp,
  rawTextValue,
  recordValue,
  textValue,
  toolCategoryByName,
  turnEndReasonFromStopValue
} from '../shared/observation/observation-projection.ts';
import { pairOpenClawToolRuns } from './tool-runs.ts';

type OpenClawMessageGroup = {
  key: string;
  deltas: string[];
  assistantText?: string;
  finalText?: string;
  finalContent?: Record<string, unknown>[];
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
      textValue(
        record.timestamp,
        providerMessage?.timestamp,
        payload?.timestamp,
        payload?.ts,
        data?.timestamp,
        data?.ts
      )
    ) ??
    providerEpochMsTimestamp(
      numberValue(
        providerMessage?.timestamp,
        record.timestamp,
        payload?.timestamp,
        payload?.ts,
        data?.timestamp,
        data?.ts
      )
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
    if (stream === 'lifecycle' && (phase === 'end' || phase === 'error' || phase === 'aborted')) {
      return observation({
        id: `${id}:json:${recordIndex}:turn-end`,
        role: 'system',
        text: textValue(data?.error) ?? (phase === 'end' ? 'complete' : phase),
        source: 'unknown',
        providerEventType: 'turn-end',
        createdAt,
        turnEndReason: turnEndReasonFromStopValue(data?.status, data?.reason, data?.stopReason),
        raw: record
      });
    }
    // Tool activity travels on the `item` stream (`kind:'tool'`, phase start/end) with the SAME
    // toolCallId the transcript's toolCall blocks carry — this is the only live tool signal the
    // gateway emits; `chat final` content strips its toolCall blocks.
    if (stream === 'item' && textValue(data?.kind) === 'tool') {
      const phase = textValue(data?.phase);
      const name = textValue(data?.name) ?? 'tool';
      const callId = textValue(data?.toolCallId, data?.itemId);
      const title = textValue(data?.title) ?? name;
      const startedAt = numberValue(data?.startedAt);
      const endedAt = numberValue(data?.endedAt);
      if (phase === 'start') {
        return observation({
          id: `${id}:json:${recordIndex}:tool-call`,
          role: 'tool',
          text: `Tool call ${title}`,
          source: 'unknown',
          providerEventType: 'tool_call',
          createdAt: providerEpochMsTimestamp(startedAt) ?? createdAt,
          hasContent: false,
          tool: {
            name,
            ...(callId ? { callId } : {}),
            status: textValue(data?.status) ?? 'running'
          },
          raw: record
        });
      }
      if (phase === 'end') {
        const error = textValue(data?.error);
        return observation({
          id: `${id}:json:${recordIndex}:tool-result`,
          role: 'tool',
          text: error ?? title,
          source: 'unknown',
          providerEventType: 'tool_result',
          createdAt: providerEpochMsTimestamp(endedAt ?? startedAt) ?? createdAt,
          hasContent: error !== undefined,
          tool: {
            name,
            ...(callId ? { callId } : {}),
            status: textValue(data?.status) ?? (error ? 'failed' : 'completed'),
            ...(error === undefined ? {} : { output: error }),
            ...(startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt
              ? { durationMs: endedAt - startedAt }
              : {})
          },
          raw: record
        });
      }
      return [];
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
        ...(providerMessage.content === undefined
          ? {}
          : { output: normalizedMcpToolOutput(textFromContent(providerMessage.content) ?? providerMessage.content) }),
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
  if (record.type !== 'event') return undefined;
  const payload = recordValue(record.payload);
  if (record.event !== 'chat' && !(record.event === 'agent' && textValue(payload?.stream) === 'assistant')) {
    return undefined;
  }
  const key = textValue(payload?.runId);
  if (!key) return undefined;
  return { key, state: { key, deltas: [], raw: [] } };
}

function openClawToolRuns(events: readonly AgentObservationEvent[]): MeshAgentObservationToolRun[] {
  return pairOpenClawToolRuns(events).map((run) => {
    const result = run.result;
    if (!result?.tool || result.tool.durationMs !== undefined || run.call.tool?.durationMs !== undefined) return run;
    const startedAt = run.call.at ? Date.parse(run.call.at) : Number.NaN;
    const completedAt = result.at ? Date.parse(result.at) : Number.NaN;
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) return run;
    return {
      ...run,
      result: { ...result, tool: { ...result.tool, durationMs: completedAt - startedAt } }
    };
  });
}

export const openClawObservationProjection = {
  classifyActivity: classifyObservationActivity,
  toolCategory: toolCategoryByName('shell', ['exec', 'shell']),
  toolRuns: openClawToolRuns,
  eventEntries: (entries: MeshAgentObservationJsonRecordEntry[], context?: { providerSessionRef?: string }) =>
    entries.filter(({ record }) => {
      if (typeof record.role === 'string' || typeof recordValue(record.message)?.role === 'string') return true;
      if (record.type !== 'event') return record.type !== 'res' && record.type !== 'req';
      const payload = recordValue(record.payload);
      const sessionKey = textValue(payload?.sessionKey);
      if (context?.providerSessionRef && sessionKey && sessionKey !== context.providerSessionRef) return false;
      if (record.event === 'chat') {
        return payload?.state === 'delta' || payload?.state === 'final' || payload?.state === 'error';
      }
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
        (stream === 'lifecycle' &&
          (phase === 'start' || phase === 'end' || phase === 'error' || phase === 'aborted')) ||
        stream === 'reasoning' ||
        stream === 'thinking' ||
        stream === 'assistant'
      )
        return true;
      if (stream === 'item') return textValue(recordValue(payload?.data)?.kind) === 'tool';
      return stream !== 'assistant' && stream !== 'lifecycle';
    }),
  isStreamingFragment: isStreamingObservationFragment,
  mergeStreamingRun: (events: MeshAgentObservationEvent[]) => {
    const first = events[0];
    const latest = events.at(-1);
    if (
      !first ||
      !latest ||
      (first.providerEventType !== 'reasoning.delta' && first.providerEventType !== 'thinking.delta')
    )
      return undefined;
    const startedAt = first.createdAt ? Date.parse(first.createdAt) : Number.NaN;
    const endedAt = latest.createdAt ? Date.parse(latest.createdAt) : Number.NaN;
    return {
      ...first,
      text: events.map((event) => event.text).join(''),
      ...(Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt
        ? { durationMs: endedAt - startedAt }
        : {}),
      provenance: { rawEvents: events.flatMap((event) => event.provenance.rawEvents) }
    };
  },
  messageGroup: {
    append(group, entry) {
      const state = group as OpenClawMessageGroup;
      const payload = recordValue(entry.record.payload);
      const data = recordValue(payload?.data);
      state.raw.push(entry.record);
      state.createdAt = openClawCreatedAt(entry.record, recordValue(payload?.message)) ?? state.createdAt;
      if (entry.record.event === 'agent' && textValue(payload?.stream) === 'assistant') {
        if (typeof data?.text === 'string') state.assistantText = data.text;
        else if (typeof data?.delta === 'string') state.deltas.push(data.delta);
      }
      if (payload?.state === 'delta' && typeof payload.deltaText === 'string') state.deltas.push(payload.deltaText);
      if (payload?.state === 'final' || payload?.state === 'error') {
        const message = recordValue(payload.message);
        state.finalText = textFromContent(message?.content) ?? textValue(payload.errorMessage);
        state.finalContent = recordContent(message?.content);
      }
    },
    create(record) {
      return openClawMessageGroup(record);
    },
    render(id, group) {
      const state = group as OpenClawMessageGroup;
      // The gateway's `chat final` message carries the same Anthropic-style content-block array the
      // transcript stores — thinking and toolCall blocks included. Emitting only the text here left
      // the live plane without tool cards entirely; they appeared only when the transcript page was
      // folded in, i.e. "loading earlier events" back-filled the NEWEST turn's cards.
      const content = state.finalContent ?? [];
      const thinkingText = content
        .map((item) =>
          item.type === 'reasoning' || item.type === 'thinking' ? (textValue(item.text, item.thinking) ?? '') : ''
        )
        .join('');
      const reasoning = thinkingText
        ? observation({
            id: `${id}:chat:${state.key}:reasoning`,
            role: 'agent' as const,
            text: thinkingText,
            source: 'unknown' as const,
            providerEventType: 'reasoning',
            createdAt: state.createdAt,
            rawEvents: state.raw,
            preserveWhitespace: true
          })
        : [];
      const toolCalls = content.flatMap((item, partIndex) => {
        if (item.type !== 'toolCall' && item.type !== 'tool_call') return [];
        const name = textValue(item.name) ?? 'tool';
        const input = item.arguments ?? item.input;
        return observation({
          id: `${id}:chat:${state.key}:tool-call:${partIndex}`,
          role: 'tool' as const,
          text: `Tool call ${name}${input === undefined ? '' : ` ${JSON.stringify(input)}`}`,
          source: 'unknown' as const,
          providerEventType: 'tool_call',
          createdAt: state.createdAt,
          tool: {
            name,
            ...(textValue(item.toolCallId, item.id) ? { callId: textValue(item.toolCallId, item.id) } : {}),
            ...(input === undefined ? {} : { input })
          },
          raw: item
        });
      });
      const message = observation({
        id: `${id}:chat:${state.key}:message`,
        role: 'agent',
        text: state.finalText ?? state.assistantText ?? state.deltas.join(''),
        source: 'unknown',
        providerEventType: state.finalText === undefined ? 'message.delta' : 'message',
        createdAt: state.createdAt,
        rawEvents: state.raw,
        preserveWhitespace: true
      });
      return [...reasoning, ...toolCalls, ...message];
    }
  },
  recordProjectors: [{ parse: ({ id, record, recordIndex }) => openClawRecordEvents(id, record, recordIndex) }]
} satisfies MeshAgentObservationProjector;
