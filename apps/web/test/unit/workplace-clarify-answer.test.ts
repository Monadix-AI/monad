import { expect, test } from 'bun:test';

import { buildClarifyAnswer } from '../../features/workplace/clarify-answer';

test('single mode sends the selected option alone', () => {
  expect(buildClarifyAnswer(['Tighten the UI'], '', false)).toBe('Tighten the UI');
});

test('single mode sends the other text alone', () => {
  expect(buildClarifyAnswer([], '  custom answer  ', false)).toBe('custom answer');
});

test('single mode sends option and other text together, newline-joined', () => {
  expect(buildClarifyAnswer(['Tighten the UI'], 'also check dark mode', false)).toBe(
    'Tighten the UI\nalso check dark mode'
  );
});

test('multiple mode sends selections and other text as a JSON array', () => {
  expect(buildClarifyAnswer(['A', 'B'], 'custom', true)).toBe(JSON.stringify(['A', 'B', 'custom']));
});

test('returns null when nothing is selected and other is blank', () => {
  expect(buildClarifyAnswer([], '   ', false)).toBeNull();
  expect(buildClarifyAnswer([], '', true)).toBeNull();
});
