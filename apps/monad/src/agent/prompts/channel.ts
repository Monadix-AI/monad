import type { ChannelRouteAction } from '@/handlers/session/channel-routing.ts';

export interface ChannelParticipant {
  id: string;
  name: string;
  kind: 'studio' | 'acp' | 'native-cli' | 'human';
  description?: string;
}

export interface BuildChannelContextInput {
  channelId: string;
  sessionId: string;
  routeKind: Exclude<ChannelRouteAction['kind'], 'none'>;
  targetName: string;
  targetRole: 'moderator' | 'agent';
  responseMode: 'moderator_structured' | 'direct_structured' | 'worker_plain';
  moderatorAgentId?: string;
  participants: readonly ChannelParticipant[];
  targetMention?: {
    id: string;
    name: string;
    agentName?: string;
    nativeCliAgentName?: string;
  };
}

export function buildChannelTurnContext({
  channelId,
  sessionId,
  routeKind,
  targetName,
  targetRole,
  responseMode,
  moderatorAgentId,
  participants,
  targetMention
}: BuildChannelContextInput): string {
  const roster = participants.length
    ? participants
        .map((participant) => {
          const details = [participant.kind, participant.description].filter(Boolean).join('; ');
          return `- ${participant.name} (${participant.id}${details ? `; ${details}` : ''}) mention_token=${mentionToken(participant)}`;
        })
        .join('\n')
    : '- No other participants are registered.';

  const behavior =
    responseMode === 'moderator_structured'
      ? [
          'You are the moderator for this channel, not a normal participant.',
          'Your job is to decide whether the latest channel-visible context needs task assignment.',
          targetMention
            ? `The user explicitly targeted ${targetMention.name} (${targetMention.id}). Treat this as a strong routing constraint.`
            : '',
          targetMention
            ? 'If the requested target is available and the task is coherent, route the work to that target instead of answering as yourself.'
            : '',
          targetMention
            ? 'When you only route the targeted work and have no user-facing content, set visibility to "silent" and leave display.content empty.'
            : '',
          targetMention
            ? 'If you cannot route the request, make a visible reply that explains the problem without sounding like an unrelated self-response.'
            : '',
          'You may answer directly when no other agent is needed.',
          'Each turn may produce zero or more task assignments.',
          'If you assign multiple tasks in one round, they must be independent and must not depend on each other.',
          'If work has dependencies, assign only the currently executable task and wait for returned results before deciding the next task.',
          'Do not continue assigning new work until all currently assigned parallel agents have returned.'
        ].filter(Boolean)
      : responseMode === 'direct_structured'
        ? [
            'You are a directly addressed participant agent in a channel with no moderator.',
            'Complete the user request using only channel-visible context.',
            'You may create follow-up task assignments only through the structured next field.'
          ]
        : [
            'You are a participant agent in this channel.',
            'Complete the assigned task from the moderator only.',
            'Return ordinary user-facing content only; do not create follow-up task assignments.',
            'Use only the channel-visible context and the task text provided in this turn.'
          ];

  const responseFormat =
    responseMode === 'worker_plain'
      ? [
          '<response_format>',
          'Return plain markdown only.',
          'Do not return JSON.',
          'Do not include a next field or assign work to other agents.',
          '</response_format>'
        ]
      : [
          '<response_format>',
          'Return exactly one JSON object and no surrounding prose.',
          'Shape: {"visibility":"visible","display":{"kind":"markdown","content":"text shown to the user"},"attachments":[],"next":[]}.',
          'visibility is "visible" by default. Use "silent" only when routing work without a user-visible moderator reply.',
          'display.content is the only user-visible content rendered by the client when visibility is "visible".',
          'attachments is optional channel-visible metadata for files or references.',
          'next is optional and contains task assignments as {"agentId":"agent id or acp:name","title":"short label","prompt":"task prompt","context":"channel-visible context"}.',
          'Use next: [] when no further task assignment is needed.',
          '</response_format>'
        ];

  return [
    '<channel_context>',
    `channel_id: ${channelId}`,
    `backing_session_id: ${sessionId}`,
    `target: ${targetName}`,
    `target_role: ${targetRole}`,
    `response_mode: ${responseMode}`,
    `route: ${routeKind}`,
    `moderator: ${moderatorAgentId ?? 'none'}`,
    targetMention ? `target_constraint: ${targetMention.name} (${targetMention.id})` : '',
    'participants:',
    roster,
    '</channel_context>',
    '',
    '<behavior_mode>',
    ...behavior,
    '</behavior_mode>',
    '',
    '<mention_syntax>',
    'Channel-visible user messages may contain strict mention tokens: @[name="display name" id="participant id"].',
    'Only strict mention tokens are actionable. Plain text like @name or email addresses are ordinary text.',
    'Use participant ids from the roster when referring to agents. Do not invent ids.',
    '</mention_syntax>',
    '',
    ...responseFormat
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function composeAcpChannelPrompt(text: string, ambientContext?: string): string {
  if (!ambientContext?.trim()) return text;
  return `${ambientContext.trim()}\n\n<channel_user_message>\n${text}\n</channel_user_message>`;
}

function mentionToken(participant: ChannelParticipant): string {
  return `@[name="${mentionEscape(participant.name)}" id="${mentionEscape(participant.id)}"]`;
}

function mentionEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
