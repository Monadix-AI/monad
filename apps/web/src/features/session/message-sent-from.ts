import type { ChannelIcon, MessageOrigin } from '@monad/protocol';
import type { ChannelOriginLabels } from '@monad/ui';
import type { MessageSentFrom } from './ChatMessage';

import { channelOriginDetails, showsChannelOrigin } from '@monad/ui';

export interface SentFromChannelOption {
  type: string;
  label: string;
  icon?: ChannelIcon;
}

/**
 * Resolves the channel-origin badge for one user message from the message's OWN persisted origin.
 *
 * Rows written before per-message provenance existed carry none and get no badge. Falling back to
 * the session's origin would be a guess: a Telegram-born session's history includes replies typed
 * on the web, and labelling those "sent from Telegram" asserts provenance that was never recorded.
 */
export function messageSentFrom(
  origin: MessageOrigin | undefined,
  channelOptions: readonly SentFromChannelOption[] | undefined,
  labels: ChannelOriginLabels
): MessageSentFrom | undefined {
  if (!showsChannelOrigin(origin)) return undefined;
  const option = channelOptions?.find((candidate) => candidate.type === origin.client);
  return {
    label: option?.label ?? (origin.client as string),
    ...(option?.icon ? { icon: option.icon } : {}),
    details: channelOriginDetails(origin, labels)
  };
}
