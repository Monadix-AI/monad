if (process.platform !== 'linux') process.exit(0);

import { expect, test } from 'bun:test';

import { defaultTransport } from '../../src/config.ts';

test('defaultTransport returns uds on Linux', () => {
  expect(defaultTransport()).toBe('uds');
});
