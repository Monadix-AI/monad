import type {
  AppendMessageCommand,
  BeginMessageCommand,
  ChatMessage,
  DeliverMessageCommand,
  Event,
  FailMessageCommand,
  IdempotencyKey,
  MessageProducer,
  RemoveMessageCommand,
  SettleMessageCommand,
  TranscriptTargetId,
  UpdateMessageCommand
} from '@monad/protocol';
import type { EventBus } from '#/services/event-bus.ts';
import type { Store } from '#/store/db/index.ts';

export interface MessageIngressDeps {
  store: Store;
  bus: EventBus;
  targetExists?: (transcriptTargetId: TranscriptTargetId) => boolean | Promise<boolean>;
  authorize?: (
    command:
      | DeliverMessageCommand
      | BeginMessageCommand
      | AppendMessageCommand
      | UpdateMessageCommand
      | SettleMessageCommand
      | FailMessageCommand
      | RemoveMessageCommand
  ) => void | Promise<void>;
  fanout?: (event: Event) => void | Promise<void>;
  now?: () => string;
}

export interface MessageIngressPublishOptions {
  fanout?: (event: Event) => void | Promise<void>;
}

export interface MessageIngress {
  /** A post-commit publication/fanout error rejects the call without undoing the message. Retrying the
   * same command must reuse its idempotency key so the durable snapshot replays without a second write. */
  deliver(
    command: DeliverMessageCommand,
    options?: MessageIngressPublishOptions
  ): Promise<import('@monad/protocol').ChatMessage>;
  /** Internal migration seam for producers whose event graph already allocated the canonical message id. */
  commit(
    input: {
      message: ChatMessage;
      idempotencyKey: IdempotencyKey;
      producer: MessageProducer;
    },
    options?: MessageIngressPublishOptions
  ): Promise<ChatMessage>;
  begin(
    command: BeginMessageCommand,
    options?: MessageIngressPublishOptions
  ): Promise<import('@monad/protocol').ChatMessage>;
  append(command: AppendMessageCommand, options?: MessageIngressPublishOptions): Promise<void>;
  update(
    command: UpdateMessageCommand,
    options?: MessageIngressPublishOptions
  ): Promise<import('@monad/protocol').ChatMessage>;
  settle(
    command: SettleMessageCommand,
    options?: MessageIngressPublishOptions
  ): Promise<import('@monad/protocol').ChatMessage>;
  fail(
    command: FailMessageCommand,
    options?: MessageIngressPublishOptions
  ): Promise<import('@monad/protocol').ChatMessage>;
  remove(
    command: RemoveMessageCommand,
    options?: MessageIngressPublishOptions
  ): Promise<import('@monad/protocol').ChatMessage>;
}
