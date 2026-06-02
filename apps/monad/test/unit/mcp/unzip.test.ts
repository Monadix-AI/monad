import { expect, test } from 'bun:test';
import { deflateRawSync } from 'node:zlib';

import { unzip } from '@/capabilities/mcp/install/unzip.ts';

/** Build a single-entry ZIP (stored or deflate) so unzip() can be tested without a zip CLI/lib. */
function makeZip(name: string, content: Uint8Array, deflate = false): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const data = deflate ? new Uint8Array(deflateRawSync(content)) : content;
  const method = deflate ? 8 : 0;

  const local = new Uint8Array(30 + nameBytes.length + data.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(8, method, true);
  lv.setUint32(18, data.length, true); // compressed size
  lv.setUint32(22, content.length, true); // uncompressed size
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(data, 30 + nameBytes.length);

  const cdOffset = local.length;
  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(10, method, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, content.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true); // local header offset
  central.set(nameBytes, 46);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true); // entries on this disk
  ev.setUint16(10, 1, true); // total entries
  ev.setUint32(12, central.length, true); // central dir size
  ev.setUint32(16, cdOffset, true); // central dir offset

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, cdOffset);
  out.set(eocd, cdOffset + central.length);
  return out;
}

test('unzip extracts a stored (uncompressed) entry', () => {
  const content = new TextEncoder().encode('hello binary');
  const files = unzip(makeZip('widget-mcp', content));
  expect(new TextDecoder().decode(files.get('widget-mcp'))).toBe('hello binary');
});

test('unzip inflates a deflate-compressed entry', () => {
  const content = new TextEncoder().encode('x'.repeat(500)); // compressible
  const files = unzip(makeZip('srv.exe', content, true));
  expect(new TextDecoder().decode(files.get('srv.exe'))).toBe('x'.repeat(500));
});

test('unzip throws on a non-zip buffer', () => {
  expect(() => unzip(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a zip/);
});
