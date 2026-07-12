import { expect, test } from 'bun:test';

import { RuntimeContext } from '#/runtime/context.ts';

test('reads committed module outputs', () => {
  const ctx = new RuntimeContext();
  ctx.commit('store', { name: 'db' });

  expect(ctx.get<{ name: string }>('store').name).toBe('db');
  expect(ctx.optional('missing')).toBeUndefined();
});

test('throws a precise error for a missing required output', () => {
  const ctx = new RuntimeContext();
  expect(() => ctx.get('model')).toThrow('runtime output "model" is unavailable');
});

test('replace returns the previous output and remove clears it', () => {
  const ctx = new RuntimeContext();
  ctx.commit('mcp', 'old');
  expect(ctx.replace('mcp', 'new')).toBe('old');
  expect(ctx.remove('mcp')).toBe('new');
  expect(ctx.optional('mcp')).toBeUndefined();
});
