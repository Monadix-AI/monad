import { describe, expect, test } from 'bun:test';

import {
  createRawStreamDecoders,
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

describe('MeshAgent raw stream decoders', () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  test('reassembles a raw payload whose character is split across two capture packets', () => {
    const decoders = createRawStreamDecoders();
    const line = encode('{"text":"你好 🌍"}\n');
    const cut = line.indexOf(0xe4) + 1;

    const packets = [decoders.stdout.decode(line.slice(0, cut)), decoders.stdout.decode(line.slice(cut))];

    expect(packets.join('')).toBe('{"text":"你好 🌍"}\n');
    expect(JSON.parse(packets.join(''))).toEqual({ text: '你好 🌍' });
  });

  test('keeps stdout and stderr partial sequences from bleeding into each other', () => {
    const decoders = createRawStreamDecoders();
    const out = encode('世');
    const err = encode('界');

    const interleaved = [
      decoders.stdout.decode(out.slice(0, 2)),
      decoders.stderr.decode(err.slice(0, 2)),
      decoders.stdout.decode(out.slice(2)),
      decoders.stderr.decode(err.slice(2))
    ];

    expect(interleaved).toEqual(['', '', '世', '界']);
  });

  test('starts a new epoch without inheriting the previous epoch trailing partial bytes', () => {
    const previous = createRawStreamDecoders();
    expect(previous.stdout.decode(encode('好').slice(0, 2))).toBe('');

    const next = createRawStreamDecoders();

    expect(next.stdout.decode(encode('ok\n'))).toBe('ok\n');
  });
});
