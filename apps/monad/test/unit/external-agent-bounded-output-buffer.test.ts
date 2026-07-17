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

test('BoundedOutputBuffer keeps framed JSON aligned to complete record boundaries', () => {
  const buffer = new BoundedOutputBuffer(64);

  buffer.appendFrame(`${JSON.stringify({ method: 'first', value: 'x'.repeat(18) })}\n`);
  buffer.appendFrame(`${JSON.stringify({ method: 'second', value: 'y'.repeat(18) })}\n`);

  const records = buffer
    .snapshot()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { method: string; value: string });
  expect(records).toEqual([{ method: 'second', value: 'y'.repeat(18) }]);
});

test('BoundedOutputBuffer drops an oversized frame without replacing the last valid snapshot', () => {
  const buffer = new BoundedOutputBuffer(64);

  const valid = `${JSON.stringify({ method: 'item/started', id: 'call_1' })}\n`;
  buffer.appendFrame(valid);
  buffer.appendFrame(`${JSON.stringify({ method: 'item/completed', output: 'x'.repeat(256) })}\n`);

  expect(buffer.snapshot()).toBe(valid);
});

test('BoundedOutputBuffer.clear starts an empty live observation epoch', () => {
  const buffer = new BoundedOutputBuffer(64);
  buffer.append('history from the previous runtime');

  buffer.clear();
  buffer.append('current epoch');

  expect({ length: buffer.length, snapshot: buffer.snapshot() }).toEqual({
    length: 13,
    snapshot: 'current epoch'
  });
});
