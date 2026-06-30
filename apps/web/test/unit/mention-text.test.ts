import { expect, test } from 'bun:test';

import { mentionSegments, mentionToken, parseMentionTokens } from '../../components/MentionText.tsx';

test('mentionSegments extracts strict agent mention tokens', () => {
  expect(mentionSegments('ask @[name="planner" id="acp:planner"] then @[name="reviewer" id="acp:reviewer"]')).toEqual([
    { kind: 'text', text: 'ask ' },
    { kind: 'mention', name: 'planner', id: 'acp:planner' },
    { kind: 'text', text: ' then ' },
    { kind: 'mention', name: 'reviewer', id: 'acp:reviewer' }
  ]);
});

test('mentionSegments extracts leading native CLI mentions before message text', () => {
  expect(mentionSegments('@[name="codex" id="native-cli:codex"] inspect repo')).toEqual([
    { kind: 'mention', name: 'codex', id: 'native-cli:codex' },
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
