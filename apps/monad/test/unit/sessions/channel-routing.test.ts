import { expect, test } from 'bun:test';

import { buildChannelTurnContext, composeAcpChannelPrompt } from '@/agent/prompts/channel.ts';
import { routeChannelMessage } from '@/handlers/session/channel-routing.ts';
import { isChannelStructuredSession } from '@/handlers/session/handlers/messaging/index.ts';

const acpAgentNames = ['planner', 'reviewer'];
const externalAgentNames = ['codex', 'claude-code'];
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

test('channel routing sends a single external agent mention directly to that external agent', () => {
  expect(
    routeChannelMessage({
      text: '@[name="codex" id="external-agent:codex"] inspect repo',
      acpAgentNames,
      externalAgentNames
    })
  ).toEqual({
    kind: 'forward-external-agent',
    agentName: 'codex',
    text: 'inspect repo',
    displayText: '@[name="codex" id="external-agent:codex"] inspect repo',
    direct: true
  });
});

test('channel routing records multiple mentions without implicit host routing', () => {
  expect(
    routeChannelMessage({
      text: `${plannerMention} compare with ${reviewerMention}`,
      acpAgentNames
    })
  ).toEqual({
    kind: 'send',
    text: `${plannerMention} compare with ${reviewerMention}`,
    generate: false
  });
});

test('channel routing treats bare at text as ordinary text', () => {
  expect(
    routeChannelMessage({
      text: '@planner inspect',
      acpAgentNames
    })
  ).toEqual({ kind: 'send', text: '@planner inspect', generate: false });
});

test('channel routing sends an explicit monad mention through normal session generation', () => {
  expect(routeChannelMessage({ text: '@[name="monad" id="monad"] summarize', acpAgentNames })).toEqual({
    kind: 'send',
    text: 'summarize',
    displayText: '@[name="monad" id="monad"] summarize',
    direct: true
  });
});

test('single direct mention routes directly to the mentioned agent', () => {
  expect(
    routeChannelMessage({
      text: `${plannerMention} inspect`,
      acpAgentNames
    })
  ).toEqual({
    kind: 'forward-acp',
    agentName: 'planner',
    text: 'inspect',
    displayText: `${plannerMention} inspect`,
    direct: true
  });
});

test('unknown mention stays as ordinary project text', () => {
  expect(
    routeChannelMessage({
      text: '@[name="unknown" id="acp:unknown"] inspect',
      acpAgentNames
    })
  ).toEqual({ kind: 'send', text: '@[name="unknown" id="acp:unknown"] inspect', generate: false });
});

test('channel context describes direct structured response contract', () => {
  const _context = buildChannelTurnContext({
    channelId: 'Control Room: design',
    sessionId: 'ses_123',
    routeKind: 'forward-acp',
    targetName: 'reviewer',
    responseMode: 'direct_structured',
    participants: [
      { id: 'human', name: 'User', kind: 'human' },
      { id: 'acp:reviewer', name: 'reviewer', kind: 'acp' }
    ]
  });
});

test('channel context gives project members a plain response mode', () => {
  const _context = buildChannelTurnContext({
    channelId: 'Control Room: design',
    sessionId: 'ses_123',
    routeKind: 'forward-acp',
    targetName: 'reviewer',
    responseMode: 'worker_plain',
    participants: [{ id: 'acp:reviewer', name: 'reviewer', kind: 'acp' }]
  });
});

test('ACP channel prompt wraps the user message after channel context', () => {
  expect(composeAcpChannelPrompt('inspect this', '<channel_context>ctx</channel_context>')).toBe(
    '<channel_context>ctx</channel_context>\n\n<channel_user_message>\ninspect this\n</channel_user_message>'
  );
  expect(composeAcpChannelPrompt('inspect this')).toBe('inspect this');
});
