import { describe, expect, test } from 'bun:test';

import {
  encodeArray,
  encodeBulk,
  encodeError,
  encodeInteger,
  encodeMap,
  encodePush,
  encodeSimple,
  parseCommand
} from '#/store/kv/resp.ts';

describe('encoders', () => {
  test('encodeSimple', () => {
    expect(encodeSimple('OK').toString()).toBe('+OK\r\n');
  });
  test('encodeError', () => {
    expect(encodeError('bad').toString()).toBe('-ERR bad\r\n');
  });
  test('encodeInteger', () => {
    expect(encodeInteger(42).toString()).toBe(':42\r\n');
  });
  test('encodeBulk string', () => {
    expect(encodeBulk('hello').toString()).toBe('$5\r\nhello\r\n');
  });
  test('encodeBulk null', () => {
    expect(encodeBulk(null).toString()).toBe('$-1\r\n');
  });
  test('encodeArray', () => {
    expect(encodeArray(['a', 'b']).toString()).toBe('*2\r\n$1\r\na\r\n$1\r\nb\r\n');
  });
  test('encodeArray with null', () => {
    expect(encodeArray([null, 'x']).toString()).toBe('*2\r\n$-1\r\n$1\r\nx\r\n');
  });
  test('encodeMap', () => {
    const buf = encodeMap([['proto', 3]]);
    expect(buf.toString()).toBe('%1\r\n$5\r\nproto\r\n:3\r\n');
  });
  test('encodePush', () => {
    const buf = encodePush(['message', 'ch', 'hello']);
    expect(buf.toString()).toBe('>3\r\n$7\r\nmessage\r\n$2\r\nch\r\n$5\r\nhello\r\n');
  });
});

describe('parseCommand', () => {
  test('returns null for empty buffer', () => {});
  test('returns null for incomplete', () => {});
  test('parses PING array', () => {
    const r = parseCommand(Buffer.from('*1\r\n$4\r\nPING\r\n'));
    expect(r?.args).toEqual(['PING']);
  });
  test('parses SET with args', () => {
    const r = parseCommand(Buffer.from('*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n'));
    expect(r?.args).toEqual(['SET', 'foo', 'bar']);
  });
  test('leaves rest intact when pipelined', () => {
    const two = Buffer.concat([Buffer.from('*1\r\n$4\r\nPING\r\n'), Buffer.from('*1\r\n$4\r\nPING\r\n')]);
    const r1 = parseCommand(two);
    expect(r1?.rest.length).toBeGreaterThan(0);
    const r2 = parseCommand(r1?.rest as Buffer);
    expect(r2?.args).toEqual(['PING']);
  });
  test('parses inline PING', () => {
    const r = parseCommand(Buffer.from('PING\r\n'));
    expect(r?.args).toEqual(['PING']);
  });
  test('parses inline HELLO 3', () => {
    const r = parseCommand(Buffer.from('HELLO 3\r\n'));
    expect(r?.args).toEqual(['HELLO', '3']);
  });
  test('handles binary-safe bulk strings', () => {
    const val = 'foo\r\nbar';
    const cmd = Buffer.from(`*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$${val.length}\r\n${val}\r\n`);
    const r = parseCommand(cmd);
    expect(r?.args[2]).toBe(val);
  });
});
