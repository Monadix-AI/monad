import { describe, expect, test } from 'bun:test';

import { createStreamingTextDecoder } from '@/services/native-cli/stream-decoder.ts';

describe('native CLI stream decoder', () => {
  test('preserves UTF-8 characters split across provider chunks', () => {
    const decoder = createStreamingTextDecoder();
    const bytes = new TextEncoder().encode('╭');

    const first = decoder.decode(bytes.slice(0, 1));
    const second = decoder.decode(bytes.slice(1));
    const final = decoder.flush();

    expect(first).toBe('');
    expect(`${first}${second}${final}`).toBe('╭');
    expect(`${first}${second}${final}`).not.toContain('\uFFFD');
  });
});
