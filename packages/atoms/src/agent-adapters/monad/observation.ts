import type { Event, MeshAgentObservationEvent } from '@monad/protocol';
import type { MeshAgentObservationProjector } from '@monad/sdk-atom';

import {
  eventEnvelopeSchema,
  sessionMessageCompletedPayloadSchema,
  sessionMessageCreatedPayloadSchema,
  sessionMessageDeltaAppendedPayloadSchema,
  sessionRunFailedPayloadSchema,
  toolCalledPayloadSchema,
  toolProgressPayloadSchema,
  toolResultPayloadSchema
} from '@monad/protocol';

import {
  classifyObservationActivity,
  isStreamingObservationFragment,
  observation,
  recordValue
} from '../observation-projection.ts';

function isMonadEventNotification(record: Record<string, unknown>): boolean {
  return record.kind === 'notification' && record.method === 'session/event';
}

function eventFromRecord(record: Record<string, unknown>): Event | undefined {
  if (!isMonadEventNotification(record)) return undefined;
  const params = record.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const parsed = eventEnvelopeSchema.safeParse((params as Record<string, unknown>).event);
  return parsed.success ? parsed.data : undefined;
}

interface MonadMessageGroup {
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning: string;
  completedText?: string;
  completedReasoning?: string;
  createdAt?: string;
  completedAt?: string;
  rawEvents: Record<string, unknown>[];
}

interface MonadToolMessage {
  messageId: string;
  phase: 'call' | 'result';
  text: string;
  toolCallId?: string;
  createdAt: string;
}

interface MonadContextCompactionMessage {
  messageId: string;
  summary?: string;
  createdAt: string;
}

function reasoningFromMessageData(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const reasoning = (data as Record<string, unknown>).reasoning;
  return typeof reasoning === 'string' && reasoning.trim() ? reasoning : undefined;
}

function jsonRecordValue(value: string): Record<string, unknown> | undefined {
  try {
    return recordValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function contextCompactionMessageFromRecord(
  record: Record<string, unknown>
): MonadContextCompactionMessage | undefined {
  const event = eventFromRecord(record);
  if (event?.type !== 'session.message.created') return undefined;
  const { message } = sessionMessageCreatedPayloadSchema.parse(event.payload);
  if (message.role !== 'assistant' || message.type !== 'directive') return undefined;
  const effect = recordValue(recordValue(message.data)?.effect);
  if (effect?.type !== 'compacted') return undefined;
  return {
    messageId: message.id,
    summary: nonEmptyString(effect.summary),
    createdAt: message.createdAt
  };
}

function toolMessageFromRecord(record: Record<string, unknown>): MonadToolMessage | undefined {
  const event = eventFromRecord(record);
  if (event?.type !== 'session.message.created') return undefined;
  const { message } = sessionMessageCreatedPayloadSchema.parse(event.payload);
  if (message.type !== 'tool_call' && message.type !== 'tool_result') return undefined;
  const data = recordValue(message.data);
  const textData = jsonRecordValue(message.text);
  const toolName = nonEmptyString(data?.toolName) ?? nonEmptyString(textData?.tool);
  const phase = message.type === 'tool_call' ? 'call' : 'result';
  return {
    messageId: message.id,
    phase,
    text: phase === 'call' ? `Tool call ${toolName ?? 'tool'}` : (nonEmptyString(data?.output) ?? message.text),
    toolCallId: nonEmptyString(data?.toolCallId),
    createdAt: message.createdAt
  };
}

function explicitToolEventKey(record: Record<string, unknown>): string | undefined {
  const event = eventFromRecord(record);
  if (event?.type === 'tool.called') {
    const payload = toolCalledPayloadSchema.parse(event.payload);
    return `call:${payload.toolCallId}`;
  }
  if (event?.type === 'tool.result') {
    const payload = toolResultPayloadSchema.parse(event.payload);
    return `result:${payload.toolCallId}`;
  }
  return undefined;
}

function messageGroupSeed(record: Record<string, unknown>): { key: string; state: MonadMessageGroup } | undefined {
  const event = eventFromRecord(record);
  if (!event) return undefined;
  if (event.type === 'session.message.delta.appended') {
    const payload = sessionMessageDeltaAppendedPayloadSchema.parse(event.payload);
    if (payload.channel !== 'text' && payload.channel !== 'reasoning') return undefined;
    return {
      key: payload.messageId,
      state: {
        messageId: payload.messageId,
        role: 'assistant',
        text: '',
        reasoning: '',
        rawEvents: []
      }
    };
  }
  if (event.type !== 'session.message.created' && event.type !== 'session.message.completed') return undefined;
  const payload =
    event.type === 'session.message.created'
      ? sessionMessageCreatedPayloadSchema.parse(event.payload)
      : sessionMessageCompletedPayloadSchema.parse(event.payload);
  if (payload.message.type !== 'text') return undefined;
  if (payload.message.role !== 'user' && payload.message.role !== 'assistant') return undefined;
  return {
    key: payload.message.id,
    state: {
      messageId: payload.message.id,
      role: payload.message.role,
      text: '',
      reasoning: '',
      rawEvents: []
    }
  };
}

function appendMessageGroup(group: MonadMessageGroup, record: Record<string, unknown>): void {
  const event = eventFromRecord(record);
  if (!event) return;
  group.rawEvents.push(record);
  if (event.type === 'session.message.delta.appended') {
    const payload = sessionMessageDeltaAppendedPayloadSchema.parse(event.payload);
    if (payload.channel === 'reasoning') group.reasoning += payload.delta;
    if (payload.channel === 'text') group.text += payload.delta;
    group.createdAt ??= event.at;
    return;
  }
  if (event.type === 'session.message.created') {
    const payload = sessionMessageCreatedPayloadSchema.parse(event.payload);
    group.role = payload.message.role === 'user' ? 'user' : 'assistant';
    group.createdAt = payload.message.createdAt;
    if (group.role === 'user') group.completedText = payload.message.text;
    return;
  }
  if (event.type === 'session.message.completed') {
    const payload = sessionMessageCompletedPayloadSchema.parse(event.payload);
    group.role = payload.message.role === 'user' ? 'user' : 'assistant';
    group.completedText = payload.message.text;
    group.completedReasoning = reasoningFromMessageData(payload.message.data);
    group.createdAt = payload.message.createdAt;
    group.completedAt = event.at;
  }
}

function renderMessageGroup(id: string, group: MonadMessageGroup): MeshAgentObservationEvent[] {
  if (group.role === 'user') {
    return observation({
      id: `${id}:message:${group.messageId}:text`,
      role: 'user',
      text: group.completedText ?? group.text,
      source: 'monad-app-server',
      providerEventType: 'session.message.created',
      createdAt: group.createdAt,
      rawEvents: group.rawEvents
    });
  }
  const reasoning = group.completedReasoning ?? group.reasoning;
  const text = group.completedText ?? group.text;
  return [
    ...observation({
      id: `${id}:message:${group.messageId}:reasoning`,
      role: 'agent',
      text: reasoning,
      source: 'monad-app-server',
      providerEventType: group.completedReasoning
        ? 'session.message.completed:reasoning'
        : 'session.message.delta.appended:reasoning',
      createdAt: group.completedAt ?? group.createdAt,
      rawEvents: group.rawEvents,
      preserveWhitespace: group.completedReasoning === undefined
    }),
    ...observation({
      id: `${id}:message:${group.messageId}:text`,
      role: 'agent',
      text,
      source: 'monad-app-server',
      providerEventType: group.completedText ? 'session.message.completed' : 'session.message.delta.appended',
      createdAt: group.completedAt ?? group.createdAt,
      rawEvents: group.rawEvents,
      preserveWhitespace: group.completedText === undefined
    })
  ];
}

function monadEventObservations(id: string, record: Record<string, unknown>): MeshAgentObservationEvent[] {
  const event = eventFromRecord(record);
  if (!event) return [];
  const contextCompaction = contextCompactionMessageFromRecord(record);
  if (contextCompaction) {
    return observation({
      id: `${id}:message:${contextCompaction.messageId}:context-compaction`,
      role: 'system',
      text: 'Context compacted',
      summary: contextCompaction.summary,
      source: 'monad-app-server',
      providerEventType: 'contextCompaction',
      createdAt: contextCompaction.createdAt,
      raw: record
    });
  }
  const toolMessage = toolMessageFromRecord(record);
  if (toolMessage) {
    const identity = toolMessage.toolCallId ?? toolMessage.messageId;
    return observation({
      id: `${id}:tool:${identity}:${toolMessage.phase}`,
      role: 'tool',
      text: toolMessage.text,
      source: 'monad-app-server',
      providerEventType: toolMessage.phase === 'call' ? 'tool.called' : 'tool.result',
      createdAt: toolMessage.createdAt,
      raw: record
    });
  }
  const common = {
    id: `${id}:${event.id}`,
    source: 'monad-app-server' as const,
    providerEventType: event.type,
    createdAt: event.at,
    raw: record
  };
  if (event.type === 'tool.called') {
    const payload = toolCalledPayloadSchema.parse(event.payload);
    return observation({
      ...common,
      id: `${id}:tool:${payload.toolCallId}:call`,
      role: 'tool',
      text: `Tool call ${payload.tool}`
    });
  }
  if (event.type === 'tool.progress') {
    const payload = toolProgressPayloadSchema.parse(event.payload);
    return observation({ ...common, role: 'tool', text: payload.output });
  }
  if (event.type === 'tool.result') {
    const payload = toolResultPayloadSchema.parse(event.payload);
    return observation({
      ...common,
      id: `${id}:tool:${payload.toolCallId}:result`,
      role: 'tool',
      text: payload.displayResult ?? payload.result
    });
  }
  if (event.type === 'session.run.completed') {
    return observation({ ...common, role: 'system', text: 'Turn completed' });
  }
  if (event.type === 'session.run.failed') {
    const payload = sessionRunFailedPayloadSchema.parse(event.payload);
    return observation({ ...common, role: 'system', text: payload.error.message });
  }
  return [];
}

export const monadObservationProjection = {
  identity: (event: MeshAgentObservationEvent) => event.id,
  checkpoint: (event: MeshAgentObservationEvent) => event.id,
  eventEntries(entries) {
    const explicitToolEvents = new Set(
      entries.map((entry) => explicitToolEventKey(entry.record)).filter((key): key is string => key !== undefined)
    );
    return entries
      .filter((entry) => {
        if (
          entry.record.kind === 'response' &&
          (entry.record.method === 'initialize' ||
            entry.record.method === 'session/open' ||
            entry.record.method === 'turn/start' ||
            entry.record.method === 'turn/steer')
        ) {
          return false;
        }
        if (
          entry.record.kind === 'notification' &&
          (entry.record.method === 'session/identified' || entry.record.method === 'session/error')
        ) {
          return false;
        }
        const event = eventFromRecord(entry.record);
        if (!event) return true;
        if (
          event.type === 'session.created' ||
          event.type === 'session.updated' ||
          event.type === 'session.message.updated' ||
          event.type === 'session.run.started' ||
          event.type === 'tool.approval_requested' ||
          event.type === 'tool.approval_resolved'
        ) {
          return false;
        }
        if (event.type === 'session.message.created' || event.type === 'session.message.completed') {
          if (contextCompactionMessageFromRecord(entry.record)) return true;
          const toolMessage = toolMessageFromRecord(entry.record);
          if (toolMessage) {
            return !toolMessage.toolCallId || !explicitToolEvents.has(`${toolMessage.phase}:${toolMessage.toolCallId}`);
          }
          return messageGroupSeed(entry.record) !== undefined;
        }
        return true;
      })
      .map((entry, index) => ({ entry, event: eventFromRecord(entry.record), index }))
      .sort((left, right) => {
        if (!left.event || !right.event) return left.index - right.index;
        const order = left.event.at.localeCompare(right.event.at);
        return order === 0 ? left.index - right.index : order;
      })
      .map(({ entry }) => entry);
  },
  classifyActivity(event: MeshAgentObservationEvent) {
    if (event.providerEventType === 'tool.called') return 'tool-call';
    if (event.providerEventType === 'tool.progress' || event.providerEventType === 'tool.result') return 'tool-result';
    if (event.providerEventType === 'session.run.completed' || event.providerEventType === 'session.run.failed') {
      return 'turn-end';
    }
    if (event.providerEventType === 'session.message.delta.appended') {
      const raw = recordValue(event.provenance.rawEvents[0]);
      const params = recordValue(raw?.params);
      const sourceEvent = recordValue(params?.event);
      const payload = recordValue(sourceEvent?.payload);
      if (payload?.channel === 'reasoning') return 'thinking';
    }
    return classifyObservationActivity(event);
  },
  isStreamingFragment(event) {
    return (
      event.providerEventType?.startsWith('session.message.delta.appended') === true ||
      isStreamingObservationFragment(event)
    );
  },
  messageGroup: {
    create: messageGroupSeed,
    append(group, entry) {
      appendMessageGroup(group as MonadMessageGroup, entry.record);
    },
    render(id, group) {
      return renderMessageGroup(id, group as MonadMessageGroup);
    }
  },
  recordProjectors: [
    {
      supports: isMonadEventNotification,
      parse: ({ id, record }) => monadEventObservations(id, record)
    }
  ]
} satisfies MeshAgentObservationProjector;
