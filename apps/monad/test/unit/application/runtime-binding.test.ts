import { expect, test } from 'bun:test';

import { createRuntimeBinding } from '#/application/agent-runtime.ts';

test('runtime binding switches all readers to the latest bound implementation', () => {
  const binding = createRuntimeBinding<(value: number) => string>((value) => `pending:${value}`);
  const read = binding.read;

  expect(read()(1)).toBe('pending:1');
  binding.bind((value) => `ready:${value}`);
  expect(read()(2)).toBe('ready:2');
  binding.bind((value) => `reloaded:${value}`);
  expect(read()(3)).toBe('reloaded:3');
});
