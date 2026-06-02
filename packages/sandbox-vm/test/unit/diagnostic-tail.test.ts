import { expect, test } from 'bun:test';

import { DiagnosticTail } from '../../src/runtime/diagnostic-tail.ts';

test('diagnostic tail retains only the newest bounded bytes', () => {
  const tail = new DiagnosticTail(5);
  tail.append(Buffer.from('abc'));
  tail.append(Buffer.from('defg'));

  expect(tail.bytes()).toEqual(Buffer.from('cdefg'));
  expect(tail.text()).toBe('cdefg');
});

test('a single oversized chunk is truncated without growing the tail', () => {
  const tail = new DiagnosticTail(3);
  tail.append(Buffer.from('abcdef'));

  expect(tail.bytes()).toEqual(Buffer.from('def'));
});
