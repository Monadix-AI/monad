if (process.platform !== 'win32') process.exit(0);

import { expect, test } from 'bun:test';

import { defaultTransport } from '../../src/config.ts';

test('defaultTransport returns tcp on Windows', () => {
  expect(defaultTransport()).toBe('tcp');
});
