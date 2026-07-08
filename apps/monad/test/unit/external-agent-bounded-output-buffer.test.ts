import { expect, test } from 'bun:test';

import { BoundedOutputBuffer } from '#/services/external-agent/bounded-output-buffer.ts';
import { appendBounded } from '#/services/external-agent/probe.ts';

test('BoundedOutputBuffer.snapshot matches the previous appendBounded semantics', () => {
  const max = 512;
  let reference = '';
  const buffer = new BoundedOutputBuffer(max);
  for (let i = 0; i < 400; i++) {
    const chunk = `chunk-${i}-${'x'.repeat(i % 30)}`;
    reference = appendBounded(reference, chunk, max);
    buffer.append(chunk);
    expect(buffer.snapshot()).toBe(reference);
  }
  expect(buffer.snapshot().length).toBeLessThanOrEqual(max);
});

test('BoundedOutputBuffer keeps the tail when a single chunk exceeds max', () => {
  const buffer = new BoundedOutputBuffer(10);
  buffer.append('abcdefghijklmnop');
  expect(buffer.snapshot()).toBe('ghijklmnop');
  expect(buffer.length).toBe(10);
});

test('BoundedOutputBuffer trims across chunk boundaries', () => {
  const buffer = new BoundedOutputBuffer(5);
  buffer.append('abc');
  buffer.append('de');
  buffer.append('fg');
  expect(buffer.snapshot()).toBe('cdefg');
});

test('BoundedOutputBuffer snapshot is stable across repeated reads and appends', () => {
  const buffer = new BoundedOutputBuffer(1024);
  buffer.append('hello');
  expect(buffer.snapshot()).toBe('hello');
  expect(buffer.snapshot()).toBe('hello');
  buffer.append(' world');
  expect(buffer.snapshot()).toBe('hello world');
  expect(buffer.snapshot()).toBe('hello world');
});
