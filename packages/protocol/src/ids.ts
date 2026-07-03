// Prefixed ULID identifiers (Crockford base32: 48-bit ms timestamp + 80 bits randomness) — sort by creation time.
// Template-literal types like `ses_${string}` can't be produced by z.infer, so the types are
// hand-written and each schema is cast to match. Keep type + schema adjacent and in sync.

import { z } from 'zod';

export type PrincipalId = `prn_${string}`;
export type AgentId = `agt_${string}`;
export type SessionId = `ses_${string}`;
export type ProjectId = `prj_${string}`;
export type TranscriptTargetId = SessionId | ProjectId;
export type TaskId = `tsk_${string}`;
export type EventId = `evt_${string}`;
export type MessageId = `msg_${string}`;
export type ChannelId = `chn_${string}`; // a configured channel instance (one bot token / one workspace app)
export type PeerId = `peer_${string}`; // a configured peer daemon (a delegation target)

export type ISO8601 = string; // always UTC ISO-8601

export function prefixedIdSchema<T extends string>(prefix: string): z.ZodType<T> {
  return z.string().regex(new RegExp(`^${prefix}_[A-Z0-9]+$`)) as unknown as z.ZodType<T>;
}

export const principalIdSchema: z.ZodType<PrincipalId> = prefixedIdSchema<PrincipalId>('prn');
export const agentIdSchema: z.ZodType<AgentId> = prefixedIdSchema<AgentId>('agt');
export const sessionIdSchema: z.ZodType<SessionId> = prefixedIdSchema<SessionId>('ses');
export const projectIdSchema: z.ZodType<ProjectId> = prefixedIdSchema<ProjectId>('prj');
export const transcriptTargetIdSchema: z.ZodType<TranscriptTargetId> = z.union([
  sessionIdSchema,
  projectIdSchema
]) as z.ZodType<TranscriptTargetId>;
export const taskIdSchema: z.ZodType<TaskId> = prefixedIdSchema<TaskId>('tsk');
export const eventIdSchema: z.ZodType<EventId> = prefixedIdSchema<EventId>('evt');
export const messageIdSchema: z.ZodType<MessageId> = prefixedIdSchema<MessageId>('msg');
export const channelIdSchema: z.ZodType<ChannelId> = prefixedIdSchema<ChannelId>('chn');
export const peerIdSchema: z.ZodType<PeerId> = prefixedIdSchema<PeerId>('peer');

export const iso8601Schema: z.ZodType<ISO8601> = z.union([
  z.string(),
  z.date().transform((d) => d.toISOString())
]) as z.ZodType<ISO8601>;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(now: number): string {
  let out = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = '';
  for (let i = 0; i < 16; i++) {
    const b = bytes[i] ?? 0;
    out += CROCKFORD[b % 32];
  }
  return out;
}

export function ulid(): string {
  return encodeTime(Date.now()) + encodeRandom();
}

export function newId<P extends string>(prefix: P): `${P}_${string}` {
  return `${prefix}_${ulid()}`;
}
