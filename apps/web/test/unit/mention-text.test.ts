import { expect, test } from 'bun:test';
import {
  mentionSegments,
  mentionToken,
  messageTextSegments,
  parseMentionTokens
} from '@monad/ui/components/MentionText';

test('mentionSegments extracts strict agent mention tokens', () => {
  expect(mentionSegments('ask @[name="planner" id="acp:planner"] then @[name="reviewer" id="acp:reviewer"]')).toEqual([
    { kind: 'text', text: 'ask ' },
    { kind: 'mention', name: 'planner', id: 'acp:planner' },
    { kind: 'text', text: ' then ' },
    { kind: 'mention', name: 'reviewer', id: 'acp:reviewer' }
  ]);
});

test('mentionSegments extracts leading MeshAgent mentions before message text', () => {
  expect(mentionSegments('@[name="codex" id="mesh-agent:codex"] inspect repo')).toEqual([
    { kind: 'mention', name: 'codex', id: 'mesh-agent:codex' },
    { kind: 'text', text: ' inspect repo' }
  ]);
});

test('mentionSegments does not split bare at text or email addresses', () => {
  expect(mentionSegments('send to z@example.com and ask @planner')).toEqual([
    { kind: 'text', text: 'send to z@example.com and ask @planner' }
  ]);
});

test('mentionToken escapes metadata values', () => {
  const text = mentionToken({ name: 'QA "Lead"', id: 'acp:qa\\lead' });
  expect(parseMentionTokens(text)).toEqual([{ name: 'QA "Lead"', id: 'acp:qa\\lead', start: 0, end: text.length }]);
});

test('messageTextSegments preserves mentions and links bare web URLs without sentence punctuation', () => {
  expect(
    messageTextSegments('Ask @[name="codex" id="mesh-agent:codex"] to open https://docs.example.com/a?q=1, then reply.')
  ).toEqual([
    { kind: 'text', text: 'Ask ' },
    { kind: 'mention', name: 'codex', id: 'mesh-agent:codex' },
    { kind: 'text', text: ' to open ' },
    { kind: 'url', href: 'https://docs.example.com/a?q=1', text: 'https://docs.example.com/a?q=1' },
    { kind: 'text', text: ', then reply.' }
  ]);
});

test('messageTextSegments leaves non-web schemes and email text unchanged', () => {
  expect(messageTextSegments('email z@example.com or use mailto:z@example.com')).toEqual([
    { kind: 'text', text: 'email z@example.com or use mailto:z@example.com' }
  ]);
});
