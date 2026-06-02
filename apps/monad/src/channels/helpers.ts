import type { MonadAuth, MonadConfig } from '@monad/home';
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

export function mentionedAgents(text: string, agents: MonadConfig['agent']['agents']): { id: string; name: string }[] {
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

export function moderatorAgentHint(cfg: MonadConfig): string {
  const roster = cfg.agent.agents.map(
    (a) => `- @${mentionHandle(a.name)} (${a.id}): ${a.description ?? 'No description'}`
  );
  return [
    'You are the moderator for this channel, not a normal participant.',
    'Your job is to decide whether the latest channel-visible context needs task assignment.',
    'You may answer directly when no other agent is needed.',
    'When assigning work, give each task a clear goal, input scope, and completion criterion.',
    'If you assign multiple tasks in one round, they must be independent and must not depend on each other.',
    'If work has a dependency, assign only the currently executable task and wait for results before deciding the next task.',
    'Use only channel-visible user messages and agent replies as context. Do not assume access to any agent private session, tool trace, scratchpad, or unrouted attachment.',
    'Do not route by writing @mentions in prose; route only through the structured channel response next array.',
    'You may return an empty next array when no task assignment is needed.',
    roster.length ? `Available agents:\n${roster.join('\n')}` : 'No configured agents are currently available.'
  ].join('\n');
}

export function channelStructuredResponseHint(): string {
  return [
    'For channel replies, return exactly one JSON object and no surrounding prose.',
    'Shape: {"visibility":"visible","display":{"kind":"markdown","content":"text shown to the user"},"attachments":[],"next":[]}.',
    'visibility defaults to "visible"; use "silent" only for moderator routing replies that should not render as a channel message.',
    'display.content is the only user-visible text rendered by the channel client when visibility is "visible".',
    'attachments is optional metadata for channel-visible files or references; do not include private tool traces.',
    'next is optional and contains task assignments as {"agentId":"agt_...","title":"short label","prompt":"task prompt","context":"channel-visible context"}.',
    'Non-moderator agents should usually return next: []; moderators may fill next when assigning work.'
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
