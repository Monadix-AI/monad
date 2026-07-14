import { expect, test } from 'bun:test';

import {
  encodeFrame,
  FrameDecoder,
  HostFrameKind,
  MAX_CONTROL_FRAME_BYTES,
  MAX_STREAM_FRAME_BYTES,
  normalizeSignal,
  VSOCK_PROTOCOL_VERSION
} from '../../src/exec/protocol.ts';

test('host protocol is version 4', () => {
  expect(VSOCK_PROTOCOL_VERSION).toBe(4);
});

test('decoder reconstructs a frame split across chunks', () => {
  const decoder = new FrameDecoder();
  const encoded = encodeFrame(HostFrameKind.Start, Buffer.from('{"version":4}'));

  expect(decoder.push(encoded.subarray(0, 3))).toEqual([]);
  expect(decoder.push(encoded.subarray(3))).toEqual([
    { kind: HostFrameKind.Start, payload: Buffer.from('{"version":4}') }
  ]);
});

test('decoder rejects an oversized control frame before receiving its body', () => {
  const decoder = new FrameDecoder();
  const header = Buffer.alloc(5);
  header[0] = HostFrameKind.Start;
  header.writeUInt32BE(MAX_CONTROL_FRAME_BYTES + 1, 1);

  expect(() => decoder.push(header)).toThrow('control frame exceeds');
});

test('encoder rejects a stream frame over the stream limit', () => {
  expect(() => encodeFrame(HostFrameKind.Stdin, Buffer.alloc(MAX_STREAM_FRAME_BYTES + 1))).toThrow(
    'stream frame exceeds'
  );
});

test('signal normalization accepts POSIX names and bounded numbers', () => {
  expect(normalizeSignal('SIGTERM')).toBe(15);
  expect(normalizeSignal('TERM')).toBe(15);
  expect(normalizeSignal(9)).toBe(9);
});

test('signal normalization rejects unsupported values', () => {
  expect(() => normalizeSignal('DELETE_EVERYTHING')).toThrow('unsupported signal');
  expect(() => normalizeSignal(0)).toThrow('unsupported signal');
  expect(() => normalizeSignal(65)).toThrow('unsupported signal');
});
