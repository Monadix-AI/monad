import { expect, test } from 'bun:test';

import { newId, ulid } from '../src/ids.ts';

test('ulid is 26 uppercase Crockford base32 chars', () => {
  expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('newId prefixes correctly', () => {
  expect(newId('ses')).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('ulids are time-sortable (monotonic prefix)', async () => {
  const a = ulid();
  await Bun.sleep(2);
  const b = ulid();
  expect(a < b).toBe(true);
});
