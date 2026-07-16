import type { ChannelInstanceConfig, MonadConfig } from '@monad/environment';
import type { ChannelInbound } from '@monad/protocol';
import type { ChannelRoute } from '#/channels/types.ts';

import { addressedToBot, channelStructuredResponseHint, mentionedAgents } from '#/channels/helpers.ts';

export function deriveKey(c: ChannelInstanceConfig, m: ChannelInbound, agentId?: string): string {
  const parts = [c.id, m.chatId];
  if (c.mapping.granularity === 'per-thread' && m.threadId) parts.push(`t:${m.threadId}`);
  else if (c.mapping.granularity === 'per-user') parts.push(`u:${m.userId}`);
  if (agentId) parts.push(`a:${agentId}`);
  return parts.join('|');
}

export function channelOriginExt(c: ChannelInstanceConfig): { agentHint?: string } | undefined {
  const hints = [c.agentHint?.trim(), channelStructuredResponseHint()].filter((s): s is string => Boolean(s));
  if (!hints.length) return undefined;
  return { agentHint: hints.join('\n\n') };
}

export function routeInbound(cfg: MonadConfig, c: ChannelInstanceConfig, m: ChannelInbound): ChannelRoute | null {
  if (m.kind === 'command') return { kind: 'default' };
  const chatType = m.chatType ?? 'dm';
  const mentions = mentionedAgents(m.text, cfg.agent.agents);
  if ((chatType === 'group' || chatType === 'channel') && cfg.agent.agents.length > 0) {
    if (mentions.length === 0) return null;
    const [agent] = mentions;
    return agent ? { kind: 'agent_direct', agentId: agent.id, agentName: agent.name } : null;
  }
  if ((c.groupPolicy?.requireMention ?? true) && !addressedToBot(m)) return null;
  return { kind: 'default' };
}

export function needsReset(c: ChannelInstanceConfig, conv: { lastSeenAt: string; createdAt: string }): boolean {
  const reset = c.mapping.reset;
  if (!reset) return false;
  if (reset.idleMinutes && Date.now() - Date.parse(conv.lastSeenAt) > reset.idleMinutes * 60_000) return true;
  if (reset.daily && new Date(conv.createdAt).toDateString() !== new Date().toDateString()) return true;
  return false;
}

/** Decide what to do with an inbound from `userId`:
 *  - 'allow': dispatch to the agent.
 *  - 'deny':  drop silently (warned by caller).
 *  - 'pair':  unknown sender on a pairing-mode DM → issue/refresh a one-time code. */
export function accessDecision(c: ChannelInstanceConfig, m: ChannelInbound): 'allow' | 'deny' | 'pair' {
  const a = c.allowlist;
  // allowAllUsers is the pre-policy escape hatch; honour it as 'open' for back-compat. An absent
  // policy defaults to 'allowlist' (default-deny).
  const policy = a.allowAllUsers ? 'open' : (a.policy ?? 'allowlist');
  if (policy === 'disabled') return 'deny';
  if (policy === 'open') return 'allow';
  if (a.allowedUsers.includes(m.userId)) return 'allow';
  // Only ever issue pairing codes in 1:1 chats — never into a group.
  if (policy === 'pairing' && (m.chatType ?? 'dm') === 'dm') return 'pair';
  return 'deny';
}
