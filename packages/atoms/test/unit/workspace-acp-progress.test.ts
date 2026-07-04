import { expect, test } from 'bun:test';

import { acpProgressText } from '../../src/workspace-experiences/chat-room/utils/projection.ts';

test('ACP progress hides empty waiting state', () => {
  expect(acpProgressText(undefined)).toBe('');
  expect(acpProgressText('waiting for response...')).toBe('');
});

test('ACP progress prefers response stream content', () => {
  expect(acpProgressText('adapter started\n\nresponse stream:\nhello from agent')).toBe('hello from agent');
});

test('ACP progress falls back to process output before response stream starts', () => {
  expect(acpProgressText('starting codex\nloading workspace')).toBe('starting codex\nloading workspace');
});
