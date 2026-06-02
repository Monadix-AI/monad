import { expect, test } from 'bun:test';

import { runDev } from '../../src/dev.ts';
import { main, USAGE_TEXT } from '../../src/main.ts';

test('cli module exports a main entry and usage text', () => {
  expect(typeof main).toBe('function');
  // Check for a command that's always present (not an i18n string that requires runtime init)
  expect(USAGE_TEXT).toContain('start');
  expect(USAGE_TEXT).toContain('monad <command>');
});

test('dev entry returns success code for one-shot command paths', async () => {
  const originalArgv = process.argv;
  process.argv = [process.argv[0] ?? 'bun', process.argv[1] ?? 'dev.ts', '--version'];
  try {
    const code = await runDev();
    expect(code).toBe(0);
  } finally {
    process.argv = originalArgv;
  }
});
