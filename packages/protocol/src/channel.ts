// Channel atom wire types. A "channel" lets an external IM platform (Telegram, Slack,
// …) reach the agent. The atom only ever sees PLATFORM-space identifiers (chatId,
// userId, threadId) — never a monad sessionId. The core owns the conversation→session
// mapping (see apps/monad services/channel).

import { z } from 'zod';

import { agentIdSchema, channelIdSchema } from './ids.ts';
import { httpUrlSchema } from './url.ts';

// First-party channel types bundled with the daemon. The schema is OPEN (any string) so a
// third-party atom can declare its own platform (e.g. "whatsapp", "matrix"); KNOWN_CHANNEL_TYPES
// stays as a hint/registry for first-party adapters and UIs.
export const KNOWN_CHANNEL_TYPES = [
  'telegram',
  'slack',
  'discord',
  'webhook',
  'irc',
  'line',
  'whatsapp',
  'whatsapp-business',
  'twilio',
  'feishu',
  'wecom',
  'teams',
  'gchat',
  'email',
  'signal',
  'qq',
  'imessage'
] as const;
export const channelTypeSchema = z.string().min(1);
export type ChannelType = z.infer<typeof channelTypeSchema>;

// What an adapter can do — drives graceful degradation in the core renderer.
export const channelCapabilitiesSchema = z.object({
  edit: z.boolean(), // can edit a sent message → enables streaming-via-edit
  typing: z.boolean(), // can show a typing indicator
  threads: z.boolean(), // native threads map to source.threadId
  maxMessageChars: z.number().int().positive(),
  markdown: z.boolean(),
  reactions: z.boolean().default(false), // can react to a message (e.g. ✅ to acknowledge a command)
  nativeCommands: z.boolean().default(false), // platform has a native command menu (push via setCommands)
  outboundMirror: z.boolean().default(false) // mirror agent replies from any client back to this channel
});
export type ChannelCapabilities = z.infer<typeof channelCapabilitiesSchema>;

export const channelMessageKindSchema = z.enum(['text', 'command', 'media', 'system']);
export type ChannelMessageKind = z.infer<typeof channelMessageKindSchema>;

// Where the message originated. Drives the group-mention gate: in a group/channel the bot stays
// quiet unless addressed (see channelGroupPolicySchema). 'dm' is a 1:1 conversation.
export const channelChatTypeSchema = z.enum(['dm', 'group', 'channel']);
export type ChannelChatType = z.infer<typeof channelChatTypeSchema>;

// A required/optional env var a channel needs — drives setup-wizard / UI prompts.
export const channelEnvVarSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  required: z.boolean().default(true),
  secret: z.boolean().optional(),
  credentialKey: z.string().min(1).optional()
});
export type ChannelEnvVar = z.infer<typeof channelEnvVarSchema>;

const channelIconHexColorSchema = z.string().regex(/^#[0-9a-f]{3,8}$/i);
const channelIconFillSchema = z.union([z.enum(['currentColor', 'none']), channelIconHexColorSchema]);
const channelIconGradientIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/i);

const channelIconGradientStopSchema = z.object({
  offset: z.number().min(0).max(1),
  color: channelIconHexColorSchema,
  opacity: z.number().min(0).max(1).optional()
});

const channelIconLinearGradientSchema = z.object({
  id: channelIconGradientIdSchema,
  type: z.literal('linear'),
  x1: z.number().finite(),
  y1: z.number().finite(),
  x2: z.number().finite(),
  y2: z.number().finite(),
  stops: z.array(channelIconGradientStopSchema).min(2).max(12)
});

const channelIconRadialGradientSchema = z.object({
  id: channelIconGradientIdSchema,
  type: z.literal('radial'),
  cx: z.number().finite(),
  cy: z.number().finite(),
  r: z.number().positive(),
  fx: z.number().finite().optional(),
  fy: z.number().finite().optional(),
  stops: z.array(channelIconGradientStopSchema).min(2).max(12)
});

export const channelIconGradientSchema = z.discriminatedUnion('type', [
  channelIconLinearGradientSchema,
  channelIconRadialGradientSchema
]);
export type ChannelIconGradient = z.infer<typeof channelIconGradientSchema>;

export const channelIconLayerSchema = z.object({
  path: z.string().min(1).max(50_000),
  fill: channelIconFillSchema.optional(),
  gradient: channelIconGradientIdSchema.optional(),
  stroke: channelIconFillSchema.optional(),
  strokeWidth: z.number().positive().max(100).optional(),
  strokeLinecap: z.enum(['butt', 'round', 'square']).optional(),
  strokeLinejoin: z.enum(['bevel', 'miter', 'round']).optional(),
  opacity: z.number().min(0).max(1).optional(),
  fillRule: z.enum(['evenodd', 'nonzero']).optional(),
  transform: z
    .string()
    .min(1)
    .max(240)
    .regex(/^[a-z0-9(),. +-]+$/i)
    .optional()
});
export type ChannelIconLayer = z.infer<typeof channelIconLayerSchema>;

export const channelIconSchema = z.object({
  title: z.string().min(1),
  path: z.string().min(1).max(50_000),
  hex: z
    .string()
    .regex(/^[0-9a-f]{6}$/i)
    .optional(),
  viewBox: z.tuple([z.number().finite(), z.number().finite(), z.number().positive(), z.number().positive()]).optional(),
  fillRule: z.enum(['evenodd', 'nonzero']).optional(),
  layers: z.array(channelIconLayerSchema).min(1).max(32).optional(),
  gradients: z.array(channelIconGradientSchema).min(1).max(12).optional(),
  source: httpUrlSchema.optional()
});
export type ChannelIcon = z.infer<typeof channelIconSchema>;

export const channelSetupGuideSchema = z.object({
  summary: z.string().min(1).max(500),
  steps: z.array(z.string().min(1).max(500)).min(1).max(12),
  docsUrl: httpUrlSchema.optional()
});
export type ChannelSetupGuide = z.infer<typeof channelSetupGuideSchema>;

export const channelConnectionModeSchema = z.enum(['credential', 'pairing']);
export type ChannelConnectionMode = z.infer<typeof channelConnectionModeSchema>;

// The channel-specific manifest fields (the `channel` slice of an atom manifest). Validating it
// is a security boundary — untrusted input read off disk before any atom code runs.
export const channelManifestSchema = z.object({
  type: channelTypeSchema,
  name: z.string().optional(),
  /** Module (relative to the atom dir) whose export is the ChannelDefinition / factory. */
  entry: z.string().optional(),
  /** Named export holding the definition/factory; defaults to `default` then `createAdapter`. */
  export: z.string().optional(),
  capabilities: channelCapabilitiesSchema.optional(),
  envVars: z.array(channelEnvVarSchema).optional(),
  icon: channelIconSchema.optional(),
  setup: channelSetupGuideSchema.optional(),
  connectionMode: channelConnectionModeSchema.optional()
});
export type ChannelManifest = z.infer<typeof channelManifestSchema>;

// Normalized inbound event — deliberately WITHOUT any
// session field. The adapter hands this up via ChannelContext.onMessage; the core derives
// the conversation key from {chatId,userId,threadId} and resolves the bound session.
export const channelInboundSchema = z.object({
  chatId: z.string(), // platform chat (DM/group) — reply address + conversation-key material
  userId: z.string(), // platform sender id — identity/audit/optional per-user granularity
  threadId: z.string().optional(), // platform thread/topic id (when capabilities.threads)
  text: z.string().default(''),
  kind: channelMessageKindSchema.default('text'),
  command: z.string().optional(), // command name when kind==='command' (e.g. "new") — CORE interprets, atom never executes
  commandArgs: z.array(z.string()).default([]),
  nativeMessageId: z.string(), // dedupe / echo correlation
  replyTo: z.string().optional(),
  senderDisplay: z.string().optional(),
  chatType: channelChatTypeSchema.optional(), // dm/group/channel — undefined ⇒ treated as 'dm'
  mentionedSelf: z.boolean().optional(), // bot was @mentioned (or replied-to) — gates group responses
  isSelf: z.boolean().default(false), // bot's own message → dropped
  media: z
    .array(z.object({ kind: z.string(), url: httpUrlSchema.optional(), name: z.string().optional() }))
    .default([]),
  at: z.string() // ISO-8601
});
export type ChannelInbound = z.infer<typeof channelInboundSchema>;

export const channelResponseAttachmentSchema = z.object({
  id: z.string().optional(),
  kind: z.string().min(1),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  url: httpUrlSchema.optional(),
  text: z.string().optional()
});
export type ChannelResponseAttachment = z.infer<typeof channelResponseAttachmentSchema>;

export const channelResponseNextTargetSchema = z.object({
  agentId: z.union([agentIdSchema, z.string().regex(/^acp:/, 'next target agent id must start with agt_ or acp:')]),
  title: z.string().optional(),
  prompt: z.string().min(1),
  context: z.string().optional()
});
export type ChannelResponseNextTarget = z.infer<typeof channelResponseNextTargetSchema>;

export const channelStructuredResponseSchema = z.object({
  visibility: z.enum(['visible', 'silent']).default('visible'),
  display: z.object({
    kind: z.string().min(1).default('markdown'),
    content: z.string().default('')
  }),
  attachments: z.array(channelResponseAttachmentSchema).default([]),
  next: z.array(channelResponseNextTargetSchema).default([])
});
export type ChannelStructuredResponse = z.infer<typeof channelStructuredResponseSchema>;

export function parseChannelStructuredResponse(text: string): ChannelStructuredResponse | null {
  const raw = stripJsonFence(text.trim());
  if (!raw.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = channelStructuredResponseSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function channelDisplayText(text: string): string {
  const structured = parseChannelStructuredResponse(text);
  if (!structured) return text;
  return structured.visibility === 'silent' ? '' : structured.display.content;
}

export function channelStructuredVisibility(text: string): ChannelStructuredResponse['visibility'] | null {
  return parseChannelStructuredResponse(text)?.visibility ?? null;
}

export function channelTextRenderText(text: string): string {
  const structured = parseChannelStructuredResponse(text);
  if (!structured) return text;
  if (structured.visibility === 'silent') return '';
  const lines = [structured.display.content];
  const attachmentLines = structured.attachments.map((a) => {
    const label = [a.name, a.url].filter(Boolean).join(' ');
    return label ? `- ${a.kind}: ${label}` : `- ${a.kind}`;
  });
  if (attachmentLines.length > 0) {
    lines.push('', 'Attachments:', ...attachmentLines);
  }
  return lines.join('\n').trim();
}

function stripJsonFence(text: string): string {
  if (!text.startsWith('```') || !text.endsWith('```')) return text;
  let contentStart = 3;
  const language = text.slice(contentStart, contentStart + 4);
  if (language.toLowerCase() === 'json') {
    contentStart += language.length;
  } else {
    const first = text[contentStart];
    if (first !== undefined && first !== '{' && !/\s/.test(first)) return text;
  }
  return text.slice(contentStart, -3).trim();
}

// Channel settings (HTTP CRUD DTOs): config/auth shapes live in @monad/environment; these are the
// over-the-wire views. Token material is NEVER returned — only `hasToken`.

export const channelGranularitySchema = z.enum(['per-conversation', 'per-thread', 'per-user']);
export type ChannelGranularity = z.infer<typeof channelGranularitySchema>;

// Group/channel behaviour. requireMention (default true) keeps the bot quiet in a group unless it
// is @mentioned or replied-to — so it doesn't answer every line of unrelated chatter.
export const channelGroupPolicySchema = z.object({
  requireMention: z.boolean().default(true)
});
export type ChannelGroupPolicy = z.infer<typeof channelGroupPolicySchema>;

export const channelMappingPolicySchema = z.object({
  granularity: channelGranularitySchema.default('per-conversation'),
  reset: z.object({ idleMinutes: z.number().int().positive().optional(), daily: z.boolean().optional() }).optional()
});

// What a client may write (upsert). Secrets travel via the separate credential endpoint.
export const channelInstanceViewSchema = z.object({
  id: channelIdSchema,
  type: channelTypeSchema,
  label: z.string().min(1),
  enabled: z.boolean(),
  agentId: z.string().optional(),
  // Optional for back-compat: absent ⇒ requireMention defaults to true (core-resolved).
  groupPolicy: channelGroupPolicySchema.optional(),
  mapping: channelMappingPolicySchema,
  /** Per-channel system-prompt hint injected into this channel's sessions (e.g. "IM surface —
   *  keep replies short"). */
  agentHint: z.string().max(2000).optional(),
  credentialConfigured: z.boolean(),
  rateLimitPerMin: z.number().int().positive().default(20)
});
export type ChannelInstanceView = z.infer<typeof channelInstanceViewSchema>;

export const channelStatusSchema = z.object({
  id: channelIdSchema,
  type: channelTypeSchema,
  enabled: z.boolean(),
  connected: z.boolean(),
  phase: z.enum(['disabled', 'connecting', 'pairing', 'connected', 'disconnected', 'error']),
  pairingQr: z.string().max(50_000).optional(),
  hasToken: z.boolean(),
  activeConversations: z.number().int().nonnegative(),
  lastError: z.string().optional()
});
export type ChannelStatus = z.infer<typeof channelStatusSchema>;

export const listChannelsResponseSchema = z.object({ channels: z.array(channelInstanceViewSchema) });
export type ListChannelsResponse = z.infer<typeof listChannelsResponseSchema>;

export const getChannelResponseSchema = z.object({ channel: channelInstanceViewSchema });
export type GetChannelResponse = z.infer<typeof getChannelResponseSchema>;

export const channelStatusResponseSchema = z.object({ statuses: z.array(channelStatusSchema) });
export type ChannelStatusResponse = z.infer<typeof channelStatusResponseSchema>;

export const upsertChannelRequestSchema = z.object({
  channel: channelInstanceViewSchema.omit({ credentialConfigured: true })
});
export type UpsertChannelRequest = z.infer<typeof upsertChannelRequestSchema>;

export const setChannelEnabledRequestSchema = z.object({ enabled: z.boolean() });
export type SetChannelEnabledRequest = z.infer<typeof setChannelEnabledRequestSchema>;

export const setChannelCredentialRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('replace'),
      value: z
        .object({
          token: z
            .string()
            .min(1)
            .refine((value) => !value.startsWith('${secret:'), {
              message: 'channel credential token must be stored directly'
            }),
          extra: z.record(z.string(), z.string()).optional()
        })
        .strict()
    })
    .strict(),
  z.object({ action: z.literal('remove') }).strict()
]);
export type SetChannelCredentialRequest = z.infer<typeof setChannelCredentialRequestSchema>;
