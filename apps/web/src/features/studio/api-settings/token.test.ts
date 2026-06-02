import { expect, test } from 'bun:test';

import { createApiToken, getApiTokenAction } from './token';

test('creates distinct 256-bit API tokens', () => {
  const first = createApiToken();
  const second = createApiToken();

  expect(first).toMatch(/^sk-[0-9a-f]{64}$/);
  expect(second).toMatch(/^sk-[0-9a-f]{64}$/);
  expect(second).not.toBe(first);
});

test('requires confirmation only when replacing an existing API token', () => {
  expect([getApiTokenAction(undefined), getApiTokenAction(''), getApiTokenAction('sk-existing')]).toEqual([
    'generate',
    'generate',
    'rotate'
  ]);
});
