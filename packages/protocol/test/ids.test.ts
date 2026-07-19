import { expect, test } from 'bun:test';

import { nanoid, newId, sessionIdSchema, transcriptTargetIdSchema } from '../src/ids.ts';

test('nanoid is 12 alphanumeric chars', () => {
  expect(nanoid()).toMatch(/^[0-9a-zA-Z]{12}$/);
});

test('newId prefixes correctly', () => {
  expect(newId('ses')).toMatch(/^ses_[0-9a-zA-Z]{12}$/);
});

test('newId emits parseable session ids', () => {
  const id = newId('ses');
  expect(sessionIdSchema.parse(id)).toBe(id);
});

test('transcript target ids accept sessions and projects only', () => {
  expect(transcriptTargetIdSchema.parse('ses_100000000000')).toBe('ses_100000000000');
  expect(transcriptTargetIdSchema.parse('prj_100000000000')).toBe('prj_100000000000');
  expect(() => transcriptTargetIdSchema.parse('agt_100000000000')).toThrow();
});
