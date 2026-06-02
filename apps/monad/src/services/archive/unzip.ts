import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

export interface UnzipLimits {
  maxEntries?: number;
  maxTotalBytes?: number;
}

export function unzip(bytes: Uint8Array, limits: UnzipLimits = {}): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let end = -1;
  for (let offset = bytes.byteLength - 22; offset >= 0; offset--) {
    if (u32(bytes, offset) === EOCD_SIG) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive (no end-of-central-directory record)');

  const count = u16(bytes, end + 10);
  if (limits.maxEntries !== undefined && count > limits.maxEntries) {
    throw new Error(`zip has too many entries: ${count} > ${limits.maxEntries}`);
  }
  let totalBytes = 0;
  let centralOffset = u32(bytes, end + 16);
  for (let index = 0; index < count; index++) {
    if (u32(bytes, centralOffset) !== CDH_SIG) throw new Error('invalid zip central directory');
    const method = u16(bytes, centralOffset + 10);
    if (method !== 0 && method !== 8) throw new Error(`unsupported zip compression method: ${method}`);
    const compressedSize = u32(bytes, centralOffset + 20);
    const uncompressedSize = u32(bytes, centralOffset + 24);
    totalBytes += uncompressedSize;
    if (limits.maxTotalBytes !== undefined && totalBytes > limits.maxTotalBytes) {
      throw new Error(`zip expands beyond limit: ${totalBytes} > ${limits.maxTotalBytes}`);
    }
    const nameLength = u16(bytes, centralOffset + 28);
    const extraLength = u16(bytes, centralOffset + 30);
    const commentLength = u16(bytes, centralOffset + 32);
    const localOffset = u32(bytes, centralOffset + 42);
    const name = new TextDecoder().decode(bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength));
    if (!name.endsWith('/')) {
      const localNameLength = u16(bytes, localOffset + 26);
      const localExtraLength = u16(bytes, localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(start, start + compressedSize);
      const contents = method === 8 ? new Uint8Array(inflateRawSync(compressed)) : compressed;
      if (contents.byteLength !== uncompressedSize) throw new Error(`zip entry size mismatch: ${name}`);
      files.set(name, contents);
    }
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
