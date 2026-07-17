import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { SESSION_TRANSCRIPT_STORY_CASES } from '../../stories/session-transcript-story-cases';

test('Chat Session story catalog covers every transcript card kind', () => {
  expect(SESSION_TRANSCRIPT_STORY_CASES).toEqual([
    'user-message',
    'assistant-message',
    'reasoning',
    'directive',
    'single-tool',
    'parallel-tools',
    'skill-tool',
    'external-agent-login',
    'memory-summary',
    'compact',
    'branch-restore',
    'summary-turn',
    'generic-approval',
    'resource-approval',
    'clarification',
    'complete-chat-session'
  ]);
});

test('Session-only transcript cards expose production render boundaries for Storybook', () => {
  const actionCards = readFileSync(
    new URL('../../src/features/session/SessionActionCards.tsx', import.meta.url),
    'utf8'
  );
  const transcript = readFileSync(new URL('../../src/features/session/SessionTranscript.tsx', import.meta.url), 'utf8');
  const externalLogin = readFileSync(
    new URL('../../src/features/session/ExternalAgentLoginCard.tsx', import.meta.url),
    'utf8'
  );
  const exported = (source: string) =>
    [...source.matchAll(/export (?:const|function) ([A-Z][A-Za-z0-9]+)/g)].map((match) => match[1]);

  expect(exported(actionCards)).toEqual(['ApprovalCard', 'ClarifyPrompt']);
  expect(exported(transcript).filter((name) => name === 'SummaryTranscriptTurn')).toEqual(['SummaryTranscriptTurn']);
  expect(exported(externalLogin)).toEqual(['ExternalAgentLoginCardView', 'ExternalAgentLoginCard']);
});
