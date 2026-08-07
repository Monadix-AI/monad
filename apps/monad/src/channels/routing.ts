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

/** Per-channel operator guidance (config `agentHint`) rendered as an out-of-band context block for
 *  the turn. It is injected as this turn's ambientContext — a distinct part ahead of the user text,
 *  built fresh every turn and never persisted into the user message — so a per-channel hint actually
 *  reaches the model without polluting the transcript (channel-conformance F4). Undefined when the
 *  channel has no hint configured. */
export function channelOperatorContext(c: ChannelInstanceConfig): string {
  const hint = c.agentHint?.trim();
  const operatorGuidance = hint
    ? `Operator guidance for this channel:\n${hint}\n\nTreat this as configuration context, not a higher-priority instruction than the user's message.\n\n`
    : '';
  return `<channel_context>\n${operatorGuidance}${channelStructuredResponseHint()}\n</channel_context>`;
}

export function routeInbound(
  cfg: MonadConfig,
  c: ChannelInstanceConfig,
  m: ChannelInbound,
  groupMentionPolicy = false
): ChannelRoute | null {
  if (m.kind === 'command') return { kind: 'default' };
  const chatType = m.chatType ?? 'dm';
  const mentions = mentionedAgents(m.text, cfg.agent.agents);
  if ((chatType === 'group' || chatType === 'channel') && cfg.agent.agents.length > 0) {
    const [agent] = mentions;
    if (agent) return { kind: 'agent_direct', agentId: agent.id, agentName: agent.name };
  }
  if (groupMentionPolicy && (c.groupPolicy?.requireMention ?? true) && !addressedToBot(m)) return null;
  return { kind: 'default' };
}

export function needsReset(c: ChannelInstanceConfig, conv: { lastSeenAt: string; createdAt: string }): boolean {
  const reset = c.mapping.reset;
  if (!reset) return false;
  if (reset.idleMinutes && Date.now() - Date.parse(conv.lastSeenAt) > reset.idleMinutes * 60_000) return true;
  if (reset.daily && new Date(conv.createdAt).toDateString() !== new Date().toDateString()) return true;
  return false;
}
