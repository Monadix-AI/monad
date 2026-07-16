import type { MonadAuth } from '@monad/environment';
import type { ChannelInbound } from '@monad/protocol';

const DEDUPE_CAP = 1000;

export function resolveExtra(channelId: string, auth: MonadAuth): Record<string, string> {
  return auth.channelCredentials?.[channelId]?.extra ?? {};
}

export function addressedToBot(m: ChannelInbound): boolean {
  const chatType = m.chatType ?? 'dm';
  if (chatType === 'dm') return true;
  if (m.kind === 'command') return true;
  return m.mentionedSelf === true;
}

export function mentionedAgents(
  text: string,
  agents: Array<{ id: string; name: string; dir?: string }>
): { id: string; name: string }[] {
  const handles = new Set((text.match(/@([A-Za-z0-9_-]+)/g) ?? []).map((s) => s.slice(1).toLowerCase()));
  if (!handles.size) return [];
  return agents.filter((agent) => {
    const names = new Set([
      agent.id.toLowerCase(),
      mentionHandle(agent.name),
      agent.dir ? mentionHandle(agent.dir) : ''
    ]);
    return [...handles].some((handle) => names.has(handle));
  });
}

function mentionHandle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');
}

export function channelStructuredResponseHint(): string {
  return [
    'For channel replies, return exactly one JSON object and no surrounding prose.',
    'Shape: {"visibility":"visible","display":{"kind":"markdown","content":"text shown to the user"},"attachments":[]}.',
    'visibility defaults to "visible".',
    'display.content is the only user-visible text rendered by the channel client when visibility is "visible".',
    'attachments is optional metadata for channel-visible files or references; do not include private tool traces.',
    "When visible text references a local file that should render as an attachment, use a Markdown link with title 'monad:file', for example [report.md](./report.md 'monad:file')."
  ].join('\n');
}

export function makePairingCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function sweepIdleBuckets(
  buckets: Map<string, { tokens: number; last: number }>,
  now: number,
  limit: number
): void {
  for (const [userId, b] of buckets) {
    const refilled = Math.min(limit, b.tokens + ((now - b.last) / 60_000) * limit);
    if (refilled >= limit) buckets.delete(userId);
  }
}

export function rememberSeen(seen: Set<string>, id: string): void {
  seen.add(id);
  if (seen.size > DEDUPE_CAP) {
    const first = seen.values().next().value;
    if (first !== undefined) seen.delete(first);
  }
}

export function redact(msg: string, secrets: Record<string, string>): string {
  let out = msg;
  for (const v of Object.values(secrets)) {
    if (v && v.length >= 6) out = out.split(v).join('***');
  }
  return out;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
