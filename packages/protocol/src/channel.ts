// Channel atom wire types. A "channel" lets an external IM platform (Telegram, Slack,
// …) reach the agent. The atom only ever sees PLATFORM-space identifiers (chatId,
// userId, threadId) — never a monad sessionId. The core owns the conversation→session
// mapping (see apps/monad services/channel).

import { z } from 'zod';

import { agentIdSchema, channelIdSchema } from './ids.ts';
import { okResponseSchema } from './rpc/control.ts';
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
  secret: z.boolean().optional()
});
export type ChannelEnvVar = z.infer<typeof channelEnvVarSchema>;

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
  envVars: z.array(channelEnvVarSchema).optional()
});
export type ChannelManifest = z.infer<typeof channelManifestSchema>;

// Normalized inbound event — deliberately WITHOUT any
// session field. The adapter hands this up via ChannelContext.onMessage; the core derives
// the conversation key from {chatId,userId,threadId} and resolves the bound session.
export const channelInboundSchema = z.object({
  chatId: z.string(), // platform chat (DM/group) — reply address + conversation-key material
  userId: z.string(), // platform sender id — allowlist/audit/optional per-user granularity
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
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? text;
}

// Channel settings (HTTP CRUD DTOs): config/auth shapes live in @monad/home; these are the
// over-the-wire views. Token material is NEVER returned — only `hasToken`.

export const channelGranularitySchema = z.enum(['per-conversation', 'per-thread', 'per-user']);
export type ChannelGranularity = z.infer<typeof channelGranularitySchema>;

// Inbound DM gate:
//  - 'allowlist' (default): only `allowedUsers` get through (default-deny).
//  - 'pairing':   an unknown sender gets a one-time pairing code; the operator approves it
//                 (POST pairChannel), which appends them to `allowedUsers`.
//  - 'open':      everyone gets through (still rate-limited).
//  - 'disabled':  every inbound is dropped.
// `allowAllUsers` is the pre-policy field — kept for back-compat; true ⇒ behaves as 'open'.
export const channelAccessPolicySchema = z.enum(['allowlist', 'pairing', 'open', 'disabled']);
export type ChannelAccessPolicy = z.infer<typeof channelAccessPolicySchema>;

export const channelAllowlistSchema = z.object({
  // Optional for back-compat: a config without `policy` behaves as 'allowlist' (unless the legacy
  // allowAllUsers flag is set, which behaves as 'open'). The core resolves the effective policy.
  policy: channelAccessPolicySchema.optional(),
  allowAllUsers: z.boolean().default(false),
  allowedUsers: z.array(z.string()).default([])
});

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
  options: z.record(z.string(), z.unknown()).default({}),
  allowlist: channelAllowlistSchema,
  // Optional for back-compat: absent ⇒ requireMention defaults to true (core-resolved).
  groupPolicy: channelGroupPolicySchema.optional(),
  mapping: channelMappingPolicySchema,
  /** Per-channel system-prompt hint injected into this channel's sessions (e.g. "IM surface —
   *  keep replies short"). */
  agentHint: z.string().max(2000).optional(),
  rateLimitPerMin: z.number().int().positive().default(20)
});
export type ChannelInstanceView = z.infer<typeof channelInstanceViewSchema>;

export const channelStatusSchema = z.object({
  id: channelIdSchema,
  type: channelTypeSchema,
  enabled: z.boolean(),
  connected: z.boolean(),
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

export const upsertChannelRequestSchema = z.object({ channel: channelInstanceViewSchema });
export type UpsertChannelRequest = z.infer<typeof upsertChannelRequestSchema>;

export const setChannelEnabledRequestSchema = z.object({ enabled: z.boolean() });
export type SetChannelEnabledRequest = z.infer<typeof setChannelEnabledRequestSchema>;

export const setChannelCredentialRequestSchema = z.object({
  token: z.string().min(1),
  extra: z.record(z.string(), z.string()).optional()
});
export type SetChannelCredentialRequest = z.infer<typeof setChannelCredentialRequestSchema>;

// Pairing (dmPolicy: 'pairing').
// An unknown sender on a pairing-mode channel is issued a one-time code (held in memory by the
// daemon). The operator lists pending requests and approves a code, which appends the sender's
// platform user id to the channel's allowlist. No secrets here — codes are short-lived nonces.

export const channelPairingRequestSchema = z.object({
  channelId: channelIdSchema,
  code: z.string(),
  userId: z.string(), // platform sender id awaiting approval
  senderDisplay: z.string().optional(),
  requestedAt: z.string(), // ISO-8601
  expiresAt: z.string() // ISO-8601
});
export type ChannelPairingRequest = z.infer<typeof channelPairingRequestSchema>;

export const listChannelPairingsResponseSchema = z.object({
  pairings: z.array(channelPairingRequestSchema)
});
export type ListChannelPairingsResponse = z.infer<typeof listChannelPairingsResponseSchema>;

export const approveChannelPairingRequestSchema = z.object({ code: z.string().min(1) });
export type ApproveChannelPairingRequest = z.infer<typeof approveChannelPairingRequestSchema>;

export const channelOkResponseSchema = okResponseSchema;
