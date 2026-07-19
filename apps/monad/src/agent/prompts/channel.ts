import type { ChannelRouteAction } from '#/handlers/session/channel-routing.ts';

import { definePrompt } from '#/agent/prompt-template.ts';
import channelAcpUserPath from './channel-acp-user.prompt.md' with { type: 'file' };
import channelContextPath from './channel-context.prompt.md' with { type: 'file' };

export interface ChannelParticipant {
  id: string;
  name: string;
  kind: 'studio' | 'acp' | 'mesh-agent' | 'human';
  description?: string;
}

export interface BuildChannelContextInput {
  channelId: string;
  sessionId: string;
  routeKind: Exclude<ChannelRouteAction['kind'], 'none'>;
  targetName: string;
  responseMode: 'direct_structured' | 'worker_plain';
  participants: readonly ChannelParticipant[];
  targetMention?: {
    id: string;
    name: string;
    agentName?: string;
    meshAgentName?: string;
  };
}

interface ChannelPromptData extends BuildChannelContextInput {
  participants: Array<ChannelParticipant & { details: string; mentionToken: string }>;
  userMessage?: string;
}

const CHANNEL_CONTEXT_TEMPLATE = await definePrompt<ChannelPromptData>({
  id: 'channel.context',
  sourcePath: channelContextPath
});
const CHANNEL_ACP_USER_TEMPLATE = await definePrompt<ChannelPromptData & { userMessage: string }>({
  id: 'channel.acp.user',
  sourcePath: channelAcpUserPath
});

function promptData(input: BuildChannelContextInput): ChannelPromptData {
  return {
    ...input,
    participants: input.participants.map((participant) => ({
      ...participant,
      details: [participant.kind, participant.description].filter(Boolean).join('; '),
      mentionToken: mentionToken(participant)
    }))
  };
}

export function buildChannelTurnContext(input: BuildChannelContextInput): string {
  return CHANNEL_CONTEXT_TEMPLATE.render(promptData(input));
}

export function composeAcpChannelPrompt(text: string, input?: BuildChannelContextInput): string {
  if (!input) return text;
  return CHANNEL_ACP_USER_TEMPLATE.render({ ...promptData(input), userMessage: text });
}

function mentionToken(participant: ChannelParticipant): string {
  return `@[name="${mentionEscape(participant.name)}" id="${mentionEscape(participant.id)}"]`;
}

function mentionEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
