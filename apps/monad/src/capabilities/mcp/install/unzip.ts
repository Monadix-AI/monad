// Minimal ZIP reader — enough to extract a prebuilt binary from a GitHub release .zip (the usual
// Windows asset format). Bun has no built-in unzip; this parses the central directory and inflates
// each entry (stored = method 0, deflate = method 8 via node:zlib). CRC is not verified — the
// release asset's SHA-256 (checked before extraction) is the real integrity guard.

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;

function u16(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}
function u32(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;
}

/** Parse a ZIP archive into a path→bytes map (directories omitted). */
export function unzip(buf: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  // End Of Central Directory: scan backward (it sits after all entries; min size 22, + comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (u32(buf, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');

  const count = u16(buf, eocd + 10);
  let off = u32(buf, eocd + 16); // central directory offset
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(buf, off) !== CDH_SIG) break;
    const method = u16(buf, off + 10);
    const compSize = u32(buf, off + 20);
    const nameLen = u16(buf, off + 28);
    const extraLen = u16(buf, off + 30);
    const commentLen = u16(buf, off + 32);
    const localOff = u32(buf, off + 42);
    const name = dec.decode(buf.subarray(off + 46, off + 46 + nameLen));

    if (!name.endsWith('/')) {
      // The local header has its own (possibly different) extra-field length; data starts after it.
      const lNameLen = u16(buf, localOff + 26);
      const lExtraLen = u16(buf, localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);
      const data = method === 0 ? comp : new Uint8Array(inflateRawSync(comp));
      files.set(name, data instanceof Uint8Array ? data : new Uint8Array(data));
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
