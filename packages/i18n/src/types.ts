import type {
  BuiltinMessageId,
  BuiltinMessageIdForNamespace,
  BuiltinMessageIdsByNamespace,
  BuiltinMessageIdWithoutParamsForNamespace,
  BuiltinMessageIdWithParamsForNamespace,
  BuiltinMessageNamespace,
  BuiltinMessageParamsFor,
  ChannelMessageId,
  ChannelMessageIdWithoutParams,
  ChannelMessageIdWithParams,
  CliMessageId,
  CliMessageIdWithoutParams,
  CliMessageIdWithParams,
  CmdMessageId,
  CmdMessageIdWithoutParams,
  CmdMessageIdWithParams,
  DaemonMessageId,
  DaemonMessageIdWithoutParams,
  DaemonMessageIdWithParams,
  InitMessageId,
  InitMessageIdWithoutParams,
  InitMessageIdWithParams,
  StrictTranslate,
  StrictTranslateForNamespace,
  WebMessageId,
  WebMessageIdWithoutParams,
  WebMessageIdWithParams
} from '#catalog-types';

export type {
  BuiltinMessageId,
  BuiltinMessageIdForNamespace,
  BuiltinMessageIdsByNamespace,
  BuiltinMessageIdWithoutParamsForNamespace,
  BuiltinMessageIdWithParamsForNamespace,
  BuiltinMessageNamespace,
  BuiltinMessageParamsFor,
  ChannelMessageId,
  ChannelMessageIdWithoutParams,
  ChannelMessageIdWithParams,
  CliMessageId,
  CliMessageIdWithoutParams,
  CliMessageIdWithParams,
  CmdMessageId,
  CmdMessageIdWithoutParams,
  CmdMessageIdWithParams,
  DaemonMessageId,
  DaemonMessageIdWithoutParams,
  DaemonMessageIdWithParams,
  InitMessageId,
  InitMessageIdWithoutParams,
  InitMessageIdWithParams,
  StrictTranslate,
  StrictTranslateForNamespace,
  WebMessageId,
  WebMessageIdWithoutParams,
  WebMessageIdWithParams
};

export type MessageId = BuiltinMessageId | (string & {});

/** Interpolation values for a message. A `count` number drives plural-suffix selection. */
export type TParam = string | number;
export type TParams = Record<string, TParam>;

/**
 * Translate a message id to a rendered string. The `(string & {})` type keeps the parameter open
 * for any id — callers with a stricter union can narrow it themselves.
 */
export type Translate = StrictTranslate & ((key: MessageId, params?: TParams) => string);

/**
 * A language pack: a locale tag, a human-readable display name (shown in the language picker), and
 * the message map. Built-in packs (en/zh) are complete; drop-in packs may be partial — missing keys
 * resolve through the fallback chain.
 */
export interface LocalePack {
  locale: string;
  name: string;
  messages: Record<string, string>;
}
