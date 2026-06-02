export type BuiltinMessageNamespace = 'channel' | 'cli' | 'cmd' | 'daemon' | 'init' | 'web';
export type BuiltinMessageId = string;
export type ChannelMessageId = string;
export type CliMessageId = string;
export type CmdMessageId = string;
export type DaemonMessageId = string;
export type InitMessageId = string;
export type WebMessageId = string;

export type BuiltinMessageIdsByNamespace = Record<BuiltinMessageNamespace, string>;
export type BuiltinMessageIdForNamespace<Namespace extends BuiltinMessageNamespace> =
  BuiltinMessageIdsByNamespace[Namespace];

export type BuiltinMessageParamsFor<_Key extends string> = Record<string, string | number>;

export type BuiltinMessageIdWithoutParamsForNamespace<Namespace extends BuiltinMessageNamespace> =
  BuiltinMessageIdForNamespace<Namespace>;
export type BuiltinMessageIdWithParamsForNamespace<Namespace extends BuiltinMessageNamespace> =
  BuiltinMessageIdForNamespace<Namespace>;

export type ChannelMessageIdWithoutParams = ChannelMessageId;
export type ChannelMessageIdWithParams = ChannelMessageId;
export type CliMessageIdWithoutParams = CliMessageId;
export type CliMessageIdWithParams = CliMessageId;
export type CmdMessageIdWithoutParams = CmdMessageId;
export type CmdMessageIdWithParams = CmdMessageId;
export type DaemonMessageIdWithoutParams = DaemonMessageId;
export type DaemonMessageIdWithParams = DaemonMessageId;
export type InitMessageIdWithoutParams = InitMessageId;
export type InitMessageIdWithParams = InitMessageId;
export type WebMessageIdWithoutParams = WebMessageId;
export type WebMessageIdWithParams = WebMessageId;

export type StrictTranslate = (key: string, params?: Record<string, string | number>) => string;
export type StrictTranslateForNamespace<Namespace extends BuiltinMessageNamespace> = (
  key: BuiltinMessageIdForNamespace<Namespace>,
  params?: Record<string, string | number>
) => string;
