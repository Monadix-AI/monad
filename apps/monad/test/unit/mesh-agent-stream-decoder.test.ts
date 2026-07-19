import { describe, expect, test } from 'bun:test';

import {
  createStreamingTerminalTextDecoder,
  createStreamingTextDecoder
} from '#/services/mesh-agent/stream-decoder.ts';

describe('MeshAgent stream decoder', () => {
  test('preserves UTF-8 characters split across provider chunks', () => {
    const decoder = createStreamingTextDecoder();
    const bytes = new TextEncoder().encode('╭');

    const first = decoder.decode(bytes.slice(0, 1));
    const second = decoder.decode(bytes.slice(1));
    const final = decoder.flush();

    expect(first).toBe('');
    expect(`${first}${second}${final}`).toBe('╭');
  });

  test('normalizes CRLF split across terminal chunks exactly once', () => {
    const decoder = createStreamingTerminalTextDecoder();

    expect([
      decoder.decode(new TextEncoder().encode('one\r')),
      decoder.decode(new TextEncoder().encode('\ntwo\rthree'))
    ]).toEqual(['one', '\ntwo\nthree']);
    expect(decoder.flush()).toBe('');
  });

  test('flushes a trailing terminal carriage return as one newline', () => {
    const decoder = createStreamingTerminalTextDecoder();

    expect(decoder.decode(new TextEncoder().encode('prompt\r'))).toBe('prompt');
    expect(decoder.flush()).toBe('\n');
  });
});
