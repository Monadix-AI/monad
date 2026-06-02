import { expect, test } from 'bun:test';

import { untar } from '@/atoms/install/untar.ts';

const BLOCK = 512;

// Build a minimal ustar entry (regular file). Checksum is left blank — untar doesn't verify it.
function tarEntry(name: string, content: string): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const header = new Uint8Array(BLOCK);
  header.set(enc.encode(name), 0); // name
  header.set(enc.encode(`${content.length.toString(8).padStart(11, '0')}\0`), 124); // size (octal)
  header[156] = 0x30; // typeflag '0' = regular file
  const body = enc.encode(content);
  const padded = new Uint8Array(Math.ceil(body.length / BLOCK) * BLOCK);
  padded.set(body);
  const out = new Uint8Array(header.length + padded.length);
  out.set(header);
  out.set(padded, header.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

test('untar extracts npm-style package files', () => {
  const archive = concat(
    tarEntry('package/atom.json', '{"name":"x"}'),
    tarEntry('package/dist/atom-pack.js', 'export default 1;'),
    new Uint8Array(BLOCK * 2) // end-of-archive zero blocks
  );
  const files = untar(archive);
  expect(new TextDecoder().decode(files.get('package/atom.json'))).toBe('{"name":"x"}');
  expect(new TextDecoder().decode(files.get('package/dist/atom-pack.js'))).toBe('export default 1;');
});

test('untar round-trips through gzip (matches the npm fetch path)', () => {
  const archive = concat(tarEntry('package/atom.json', '{"ok":true}'), new Uint8Array(BLOCK * 2));
  const files = untar(Bun.gunzipSync(Bun.gzipSync(archive)));
  expect(new TextDecoder().decode(files.get('package/atom.json'))).toBe('{"ok":true}');
});
