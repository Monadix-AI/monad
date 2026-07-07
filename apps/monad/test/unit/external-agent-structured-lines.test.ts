import { expect, test } from 'bun:test';

import { takeCompleteStructuredLines } from '@/services/external-agent/structured-lines.ts';

test('external agent structured line buffer joins split lines and keeps partial tails', () => {
  const state = { text: '', discarding: false };

  expect(takeCompleteStructuredLines(state, '{"a":', 16)).toBe('');
  expect(takeCompleteStructuredLines(state, '1}\n{"b":', 16)).toBe('{"a":1}\n');
  expect(state).toEqual({ text: '{"b":', discarding: false });
});

test('external agent structured line buffer discards oversized lines and resumes after newline', () => {
  const state = { text: '', discarding: false };

  expect(takeCompleteStructuredLines(state, `{"huge":"${'x'.repeat(32)}`, 16)).toBe('');
  expect(state.discarding).toBe(true);
  expect(takeCompleteStructuredLines(state, '"}\n{"ok":true}\n', 16)).toBe('{"ok":true}\n');
  expect(state).toEqual({ text: '', discarding: false });
});

test('external agent structured line buffer filters oversized complete lines without dropping following lines', () => {
  const state = { text: '', discarding: false };

  expect(takeCompleteStructuredLines(state, `${'x'.repeat(20)}\n{"ok":true}\n`, 16)).toBe('{"ok":true}\n');
  expect(state).toEqual({ text: '', discarding: false });
});
