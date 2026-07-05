import { expect, test } from 'bun:test';

import { buildChannelTurnContext, composeAcpChannelPrompt } from '@/agent/prompts/channel.ts';
import { normalizeChannelModeratorId, routeChannelMessage } from '@/handlers/session/channel-routing.ts';
import { isChannelStructuredSession } from '@/handlers/session/handlers/messaging.ts';

const acpAgentNames = ['planner', 'reviewer'];
const nativeCliAgentNames = ['codex', 'claude-code'];
const plannerMention = '@[name="planner" id="acp:planner"]';
const reviewerMention = '@[name="reviewer" id="acp:reviewer"]';

test('channel routing ignores blank messages', () => {
  expect(routeChannelMessage({ text: '  ', acpAgentNames })).toEqual({ kind: 'none' });
});

test('workplace sessions use the channel structured projection contract', () => {
  expect(
    isChannelStructuredSession({
      title: 'Workplace: project-2026',
      origin: { surface: 'web', client: 'workplace', transport: 'http', writableBy: ['http'], branchableBy: ['http'] }
    })
  ).toBe(true);
});

test('channel routing records bare no-host messages without generation', () => {
  expect(routeChannelMessage({ text: '  hello channel  ', acpAgentNames })).toEqual({
    kind: 'send',
    text: 'hello channel',
    generate: false
  });
});

test('channel routing allows slash commands without a host', () => {
  expect(routeChannelMessage({ text: '/help', acpAgentNames })).toEqual({
    kind: 'send',
    text: '/help',
    generate: true
  });
});

test('channel routing sends a single ACP mention directly to that ACP agent', () => {
  expect(routeChannelMessage({ text: `${plannerMention} draft options`, acpAgentNames })).toEqual({
    kind: 'forward-acp',
    agentName: 'planner',
    text: 'draft options',
    displayText: `${plannerMention} draft options`,
    direct: true
  });
});

test('channel routing sends a single inline ACP mention directly to that ACP agent', () => {
  expect(routeChannelMessage({ text: `please ${plannerMention} draft options`, acpAgentNames })).toEqual({
    kind: 'forward-acp',
    agentName: 'planner',
    text: 'please draft options',
    displayText: `please ${plannerMention} draft options`,
    direct: true
  });
});

test('channel routing sends a single native CLI mention directly to that native CLI agent', () => {
  expect(
    routeChannelMessage({
      text: '@[name="codex" id="native-cli:codex"] inspect repo',
      acpAgentNames,
      nativeCliAgentNames
    })
  ).toEqual({
    kind: 'forward-native-cli',
    agentName: 'codex',
    text: 'inspect repo',
    displayText: '@[name="codex" id="native-cli:codex"] inspect repo',
    direct: true
  });
});

test('channel routing sends multiple mentions to the configured host', () => {
  expect(
    routeChannelMessage({
      text: `${plannerMention} compare with ${reviewerMention}`,
      moderatorAgentId: 'acp:reviewer',
      acpAgentNames
    })
  ).toEqual({
    kind: 'forward-acp',
    agentName: 'reviewer',
    text: `${plannerMention} compare with ${reviewerMention}`
  });
});

test('channel routing treats bare at text as ordinary text', () => {
  expect(
    routeChannelMessage({
      text: '@planner inspect',
      moderatorAgentId: 'acp:reviewer',
      acpAgentNames
    })
  ).toEqual({ kind: 'forward-acp', agentName: 'reviewer', text: '@planner inspect' });
});

test('channel routing sends an explicit monad mention through normal session generation', () => {
  expect(routeChannelMessage({ text: '@[name="monad" id="monad"] summarize', acpAgentNames })).toEqual({
    kind: 'send',
    text: 'summarize',
    displayText: '@[name="monad" id="monad"] summarize',
    direct: true
  });
});

test('channel routing sends bare messages to a Studio host when configured', () => {
  expect(
    routeChannelMessage({
      text: 'decide next step',
      moderatorAgentId: 'agent:agt_host',
      acpAgentNames
    })
  ).toEqual({ kind: 'send', text: 'decide next step' });
});

test('channel routing forwards bare messages to an ACP host when configured', () => {
  expect(
    routeChannelMessage({
      text: 'decide next step',
      moderatorAgentId: 'acp:reviewer',
      acpAgentNames
    })
  ).toEqual({ kind: 'forward-acp', agentName: 'reviewer', text: 'decide next step' });
});

test('single direct mention takes precedence over the configured host', () => {
  expect(
    routeChannelMessage({
      text: `${plannerMention} inspect`,
      moderatorAgentId: 'agent:agt_host',
      acpAgentNames
    })
  ).toEqual({
    kind: 'send',
    text: `${plannerMention} inspect`,
    targetMention: { id: 'acp:planner', name: 'planner', agentName: 'planner' }
  });
});

test('single direct mention is a strong constraint for an ACP host', () => {
  expect(
    routeChannelMessage({
      text: `${plannerMention} inspect`,
      moderatorAgentId: 'acp:reviewer',
      acpAgentNames
    })
  ).toEqual({
    kind: 'forward-acp',
    agentName: 'reviewer',
    text: `${plannerMention} inspect`,
    targetMention: { id: 'acp:planner', name: 'planner', agentName: 'planner' }
  });
});

test('unknown mention falls back to the host when configured', () => {
  expect(
    routeChannelMessage({
      text: '@[name="unknown" id="acp:unknown"] inspect',
      moderatorAgentId: 'acp:reviewer',
      acpAgentNames
    })
  ).toEqual({ kind: 'forward-acp', agentName: 'reviewer', text: '@[name="unknown" id="acp:unknown"] inspect' });
});

test('legacy bare agent ids normalize to Studio host ids', () => {
  expect(normalizeChannelModeratorId('agt_123')).toBe('agent:agt_123');
  expect(normalizeChannelModeratorId('agent:agt_123')).toBe('agent:agt_123');
  expect(normalizeChannelModeratorId({ id: 'agt_123' })).toBeUndefined();
});

test('channel context describes moderator duties and structured response contract', () => {
  const context = buildChannelTurnContext({
    channelId: 'Control Room: design',
    sessionId: 'ses_123',
    routeKind: 'send',
    targetName: 'Channel Host',
    targetRole: 'moderator',
    responseMode: 'moderator_structured',
    moderatorAgentId: 'agent:agt_host',
    participants: [
      { id: 'human', name: 'User', kind: 'human' },
      { id: 'agent:agt_host', name: 'Channel Host', kind: 'studio', description: 'routes work' },
      { id: 'acp:reviewer', name: 'reviewer', kind: 'acp' }
    ]
  });

  expect(context).toContain('channel_id: Control Room: design');
  expect(context).toContain('target_role: moderator');
  expect(context).toContain('response_mode: moderator_structured');
  expect(context).toContain('Each turn may produce zero or more task assignments.');
  expect(context).toContain('they must be independent and must not depend on each other');
  expect(context).toContain('Return exactly one JSON object and no surrounding prose.');
  expect(context).toContain('"visibility":"visible"');
  expect(context).toContain("[report.md](./report.md 'monad:file')");
  expect(context).toContain('- reviewer (acp:reviewer; acp)');
  expect(context).toContain('@[name="reviewer" id="acp:reviewer"]');
});

test('channel context gives worker agents a plain response mode under a moderator', () => {
  const context = buildChannelTurnContext({
    channelId: 'Control Room: design',
    sessionId: 'ses_123',
    routeKind: 'forward-acp',
    targetName: 'reviewer',
    targetRole: 'agent',
    responseMode: 'worker_plain',
    moderatorAgentId: 'agent:agt_host',
    participants: [{ id: 'acp:reviewer', name: 'reviewer', kind: 'acp' }]
  });

  expect(context).toContain('target_role: agent');
  expect(context).toContain('response_mode: worker_plain');
  expect(context).toContain('Complete the assigned task from the moderator only.');
  expect(context).toContain('Return plain markdown only.');
  expect(context).toContain("[report.md](./report.md 'monad:file')");
  expect(context).not.toContain('You are the moderator for this channel');
});

test('channel context tells a moderator to silently route explicit single-target mentions', () => {
  const context = buildChannelTurnContext({
    channelId: 'Control Room: design',
    sessionId: 'ses_123',
    routeKind: 'forward-acp',
    targetName: 'reviewer',
    targetRole: 'moderator',
    responseMode: 'moderator_structured',
    moderatorAgentId: 'acp:reviewer',
    targetMention: { id: 'acp:planner', name: 'planner', agentName: 'planner' },
    participants: [
      { id: 'acp:planner', name: 'planner', kind: 'acp' },
      { id: 'acp:reviewer', name: 'reviewer', kind: 'acp' }
    ]
  });

  expect(context).toContain('target_constraint: planner (acp:planner)');
  expect(context).toContain('Treat this as a strong routing constraint.');
  expect(context).toContain('set visibility to "silent"');
});

test('ACP channel prompt wraps the user message after channel context', () => {
  expect(composeAcpChannelPrompt('inspect this', '<channel_context>ctx</channel_context>')).toBe(
    '<channel_context>ctx</channel_context>\n\n<channel_user_message>\ninspect this\n</channel_user_message>'
  );
  expect(composeAcpChannelPrompt('inspect this')).toBe('inspect this');
});
