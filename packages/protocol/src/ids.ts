// Prefixed nanoid identifiers: prefix_ followed by 12 chars from 0-9a-zA-Z.
// Template-literal types like `ses_${string}` can't be produced by z.infer, so the types are
// hand-written and each schema is cast to match. Keep type + schema adjacent and in sync.

import { z } from 'zod';

export type AgentId = `agt_${string}`;
export type SessionId = `ses_${string}`;
export type ProjectId = `prj_${string}`;
export type TranscriptTargetId = SessionId | ProjectId;
export type TaskId = `tsk_${string}`;
export type EventId = `evt_${string}`;
export type MessageId = `msg_${string}`;
export type ChannelId = `chn_${string}`; // a configured channel instance (one bot token / one workspace app)
export type PeerId = `peer_${string}`; // a configured peer daemon (a delegation target)
export type AttachmentId = `att_${string}`; // an out-of-band message body (spilled long content)
export type NativeAgentDeliveryId = `deliv_${string}`;
export type MeshSessionId = `mesh_${string}`;
export type MeshAgentAuthSessionId = `ncliauth_${string}`;
export type IdempotencyKey = `idem_${string}`;

export type ISO8601 = string; // always UTC ISO-8601

export const ID_BODY_LENGTH = 12;
export const ID_BODY_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ID_BODY_PATTERN = `[0-9a-zA-Z]{${ID_BODY_LENGTH}}`;
const ID_BODY_MASK = (2 << Math.floor(Math.log2(ID_BODY_ALPHABET.length - 1))) - 1;
const ID_BODY_STEP = Math.ceil((1.6 * ID_BODY_MASK * ID_BODY_LENGTH) / ID_BODY_ALPHABET.length);

export function prefixedIdSchema<T extends string>(prefix: string): z.ZodType<T> {
  return z.string().regex(new RegExp(`^${prefix}_${ID_BODY_PATTERN}$`)) as unknown as z.ZodType<T>;
}

export const agentIdSchema: z.ZodType<AgentId> = prefixedIdSchema<AgentId>('agt');
export const sessionIdSchema: z.ZodType<SessionId> = prefixedIdSchema<SessionId>('ses');
export const projectIdSchema: z.ZodType<ProjectId> = prefixedIdSchema<ProjectId>('prj');
export const transcriptTargetIdSchema: z.ZodType<TranscriptTargetId> = z.union([sessionIdSchema, projectIdSchema]);
export const taskIdSchema: z.ZodType<TaskId> = prefixedIdSchema<TaskId>('tsk');
export const eventIdSchema: z.ZodType<EventId> = prefixedIdSchema<EventId>('evt');
export const messageIdSchema: z.ZodType<MessageId> = prefixedIdSchema<MessageId>('msg');
export const channelIdSchema: z.ZodType<ChannelId> = prefixedIdSchema<ChannelId>('chn');
export const peerIdSchema: z.ZodType<PeerId> = prefixedIdSchema<PeerId>('peer');
export const attachmentIdSchema: z.ZodType<AttachmentId> = prefixedIdSchema<AttachmentId>('att');
export const nativeAgentDeliveryIdSchema: z.ZodType<NativeAgentDeliveryId> =
  prefixedIdSchema<NativeAgentDeliveryId>('deliv');
export const meshSessionIdSchema: z.ZodType<MeshSessionId> = prefixedIdSchema<MeshSessionId>('mesh');
export const meshAgentAuthSessionIdSchema: z.ZodType<MeshAgentAuthSessionId> =
  prefixedIdSchema<MeshAgentAuthSessionId>('ncliauth');
export const idempotencyKeySchema: z.ZodType<IdempotencyKey> = prefixedIdSchema<IdempotencyKey>('idem');

export const iso8601Schema: z.ZodType<ISO8601> = z.union([
  z.string(),
  z.date().transform((d) => d.toISOString())
]) as z.ZodType<ISO8601>;

export function nanoid(): string {
  let out = '';
  while (out.length < ID_BODY_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(ID_BODY_STEP));
    for (const byte of bytes) {
      const index = byte & ID_BODY_MASK;
      if (index >= ID_BODY_ALPHABET.length) continue;
      out += ID_BODY_ALPHABET[index] ?? '';
      if (out.length === ID_BODY_LENGTH) return out;
    }
  }
  return out;
}

export function newId<P extends string>(prefix: P): `${P}_${string}` {
  return `${prefix}_${nanoid()}`;
}
