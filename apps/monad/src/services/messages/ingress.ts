import type {
  AppendMessageCommand,
  BeginMessageCommand,
  ChatMessage,
  DeliverMessageCommand,
  Event,
  EventType,
  FailMessageCommand,
  IdempotencyKey,
  MessageProducer,
  RemoveMessageCommand,
  SettleMessageCommand,
  TranscriptTargetId,
  UpdateMessageCommand
} from '@monad/protocol';
import type { MessageMutationResult } from '#/store/db/message-mutations.ts';
import type { MessageIngress, MessageIngressDeps, MessageIngressPublishOptions } from './types.ts';

import {
  appendMessageCommandSchema,
  beginMessageCommandSchema,
  deliverMessageCommandSchema,
  eventDefinition,
  failMessageCommandSchema,
  newId,
  removeMessageCommandSchema,
  settleMessageCommandSchema,
  updateMessageCommandSchema,
  validateMessageData
} from '@monad/protocol';

import { makeEvent } from '#/services/event-bus.ts';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stableValue(entry)])
  );
}

function fingerprint(operation: string, command: unknown): string {
  return `${operation}:${JSON.stringify(stableValue(command))}`;
}

export function messageIdempotencyKey(...parts: readonly string[]): IdempotencyKey {
  const hash = new Bun.CryptoHasher('sha256');
  for (const part of parts) hash.update(`${part.length}:${part}`);
  return `idem_${hash.digest('hex').slice(0, 12)}`;
}

function actorAgentId(producer: MessageProducer): Event['actorAgentId'] {
  return producer.kind === 'agent' ? producer.agentId : null;
}

function messageData(type: string, data: unknown): unknown {
  const result = validateMessageData(type, data);
  if (!result.ok) throw new Error(`invalid message data: ${result.error}`);
  return result.data;
}

function defaultTargetExists(deps: MessageIngressDeps, transcriptTargetId: TranscriptTargetId): boolean {
  if (transcriptTargetId.startsWith('ses_')) return deps.store.getSession(transcriptTargetId) !== null;
  return deps.store.getWorkplaceProject(transcriptTargetId) !== null;
}

export function createMessageIngress(deps: MessageIngressDeps): MessageIngress {
  const deltaIndexes = new Map<string, Map<string, number>>();
  const now = deps.now ?? (() => new Date().toISOString());

  const deltaMessageKey = (transcriptTargetId: TranscriptTargetId, messageId: string): string =>
    `${transcriptTargetId}:${messageId}`;

  async function validate(
    command:
      | DeliverMessageCommand
      | BeginMessageCommand
      | AppendMessageCommand
      | UpdateMessageCommand
      | SettleMessageCommand
      | FailMessageCommand
      | RemoveMessageCommand
  ): Promise<void> {
    await deps.authorize?.(command);
    const exists = await (deps.targetExists?.(command.transcriptTargetId) ??
      defaultTargetExists(deps, command.transcriptTargetId));
    if (!exists) throw new Error(`transcript target not found: ${command.transcriptTargetId}`);
  }

  async function postCommit(
    result: MessageMutationResult,
    type: EventType,
    payload: object,
    producer: MessageProducer,
    fanout: boolean,
    options?: MessageIngressPublishOptions
  ): Promise<ChatMessage> {
    if (!result.changed) return result.message;
    const event = makeEvent(result.message.sessionId, type, payload, {
      actorAgentId: actorAgentId(producer)
    });
    const errors: unknown[] = [];
    if (eventDefinition(type).persistence === 'durable') {
      try {
        deps.store.appendEvents([event]);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      deps.bus.publish(event);
    } catch (error) {
      errors.push(error);
    }
    if (fanout && deps.fanout) {
      try {
        await deps.fanout(event);
      } catch (error) {
        errors.push(error);
      }
    }
    if (fanout && options?.fanout) {
      try {
        await options.fanout(event);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'message post-commit publication failed');
    return result.message;
  }

  async function create(
    command: DeliverMessageCommand | BeginMessageCommand,
    operation: 'deliver' | 'begin',
    options?: MessageIngressPublishOptions
  ): Promise<ChatMessage> {
    await validate(command);
    const data =
      operation === 'begin' && command.data === undefined ? undefined : messageData(command.type, command.data);
    const messageId = newId('msg');
    const message: ChatMessage = {
      id: messageId,
      sessionId: command.transcriptTargetId,
      role: command.role,
      text: command.text,
      type: command.type,
      ...(command.data === undefined ? {} : { data }),
      stream:
        operation === 'begin'
          ? { status: 'pending', source: { transcriptTargetId: command.transcriptTargetId, messageId } }
          : { status: 'settled' },
      active: true,
      ...(command.includeInContext === undefined ? {} : { includeInContext: command.includeInContext }),
      createdAt: now()
    };
    const result = deps.store.createMessage({
      message,
      idempotencyKey: command.idempotencyKey,
      fingerprint: fingerprint(operation, command)
    });
    return postCommit(
      result,
      'session.message.created',
      {
        transcriptTargetId: command.transcriptTargetId,
        producer: command.producer,
        message: result.message,
        messageRevision: result.messageRevision
      },
      command.producer,
      true,
      options
    );
  }

  async function commitPrepared(
    input: {
      message: ChatMessage;
      idempotencyKey: IdempotencyKey;
      producer: MessageProducer;
    },
    options?: MessageIngressPublishOptions
  ): Promise<ChatMessage> {
    await validate({
      transcriptTargetId: input.message.sessionId,
      messageId: input.message.id,
      producer: input.producer,
      channel: 'prepared',
      index: 0,
      delta: ''
    });
    messageData(input.message.type, input.message.data);
    const result = deps.store.createMessage({
      message: input.message,
      idempotencyKey: input.idempotencyKey,
      fingerprint: fingerprint('commit', input)
    });
    return postCommit(
      result,
      'session.message.created',
      {
        transcriptTargetId: input.message.sessionId,
        producer: input.producer,
        message: result.message,
        messageRevision: result.messageRevision
      },
      input.producer,
      true,
      options
    );
  }

  return {
    commit: commitPrepared,
    async deliver(input, options) {
      const command = deliverMessageCommandSchema.parse(input);
      return create(command, 'deliver', options);
    },

    async begin(input, options) {
      const command = beginMessageCommandSchema.parse(input);
      return create(command, 'begin', options);
    },

    async append(input, options) {
      const command = appendMessageCommandSchema.parse(input);
      await validate(command);
      const message = deps.store.getMessage(command.transcriptTargetId, command.messageId);
      if (!message) throw new Error(`message not found: ${command.messageId}`);
      if (message.stream.status !== 'pending' && message.stream.status !== 'streaming') {
        throw new Error(`message is already terminal: ${command.messageId}`);
      }
      const key = deltaMessageKey(command.transcriptTargetId, command.messageId);
      const channels = deltaIndexes.get(key) ?? new Map<string, number>();
      const previous = channels.get(command.channel) ?? -1;
      if (command.index <= previous) throw new Error('delta index must increase monotonically');
      channels.set(command.channel, command.index);
      deltaIndexes.set(key, channels);
      const event = makeEvent(command.transcriptTargetId, 'session.message.delta.appended', {
        transcriptTargetId: command.transcriptTargetId,
        messageId: command.messageId,
        producer: command.producer,
        channel: command.channel,
        index: command.index,
        delta: command.delta
      });
      deps.bus.publish(event);
      await deps.fanout?.(event);
      await options?.fanout?.(event);
    },

    async update(input, options) {
      const command = updateMessageCommandSchema.parse(input);
      await validate(command);
      const current = deps.store.getMessage(command.transcriptTargetId, command.messageId);
      if (!current) throw new Error(`message not found: ${command.messageId}`);
      if (command.updates.type !== undefined || Object.hasOwn(command.updates, 'data')) {
        messageData(command.updates.type ?? current.type, command.updates.data ?? current.data);
      }
      const result = deps.store.updateMessage({
        transcriptTargetId: command.transcriptTargetId,
        messageId: command.messageId,
        idempotencyKey: command.idempotencyKey,
        fingerprint: fingerprint('update', command),
        updates: command.updates,
        updatedAt: now()
      });
      return postCommit(
        result,
        'session.message.updated',
        {
          transcriptTargetId: command.transcriptTargetId,
          producer: command.producer,
          message: result.message,
          messageRevision: result.messageRevision
        },
        command.producer,
        true,
        options
      );
    },

    async settle(input, options) {
      const command = settleMessageCommandSchema.parse(input);
      await validate(command);
      const current = deps.store.getMessage(command.transcriptTargetId, command.messageId);
      if (!current) throw new Error(`message not found: ${command.messageId}`);
      const type = command.type ?? current.type;
      const data = 'data' in command ? messageData(type, command.data) : undefined;
      const result = deps.store.settleMessage({
        transcriptTargetId: command.transcriptTargetId,
        messageId: command.messageId,
        idempotencyKey: command.idempotencyKey,
        fingerprint: fingerprint('settle', command),
        text: command.text,
        ...('type' in command ? { type } : {}),
        ...('data' in command ? { data } : {}),
        ...('includeInContext' in command ? { includeInContext: command.includeInContext } : {}),
        updatedAt: now()
      });
      deltaIndexes.delete(deltaMessageKey(command.transcriptTargetId, command.messageId));
      return postCommit(
        result,
        'session.message.completed',
        {
          transcriptTargetId: command.transcriptTargetId,
          producer: command.producer,
          message: result.message,
          messageRevision: result.messageRevision
        },
        command.producer,
        true,
        options
      );
    },

    async fail(input, options) {
      const command = failMessageCommandSchema.parse(input);
      await validate(command);
      const current = deps.store.getMessage(command.transcriptTargetId, command.messageId);
      if (!current) throw new Error(`message not found: ${command.messageId}`);
      const type = command.type ?? current.type;
      const data = command.data === undefined ? current.data : messageData(type, command.data);
      const result = deps.store.failMessage({
        transcriptTargetId: command.transcriptTargetId,
        messageId: command.messageId,
        idempotencyKey: command.idempotencyKey,
        fingerprint: fingerprint('fail', command),
        text: command.error.message,
        ...('type' in command ? { type } : {}),
        ...(data === undefined ? {} : { data }),
        ...('includeInContext' in command ? { includeInContext: command.includeInContext } : {}),
        updatedAt: now()
      });
      deltaIndexes.delete(deltaMessageKey(command.transcriptTargetId, command.messageId));
      return postCommit(
        result,
        'session.message.failed',
        {
          transcriptTargetId: command.transcriptTargetId,
          producer: command.producer,
          message: result.message,
          messageRevision: result.messageRevision
        },
        command.producer,
        true,
        options
      );
    },

    async remove(input, options) {
      const command = removeMessageCommandSchema.parse(input);
      await validate(command);
      const result = deps.store.removeMessage({
        transcriptTargetId: command.transcriptTargetId,
        messageId: command.messageId,
        idempotencyKey: command.idempotencyKey,
        fingerprint: fingerprint('remove', command),
        updatedAt: now()
      });
      deltaIndexes.delete(deltaMessageKey(command.transcriptTargetId, command.messageId));
      return postCommit(
        result,
        'session.message.deleted',
        {
          transcriptTargetId: command.transcriptTargetId,
          producer: command.producer,
          messageId: command.messageId,
          messageRevision: result.messageRevision
        },
        command.producer,
        true,
        options
      );
    }
  };
}
