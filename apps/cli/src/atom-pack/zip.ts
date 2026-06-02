import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const encoder = new TextEncoder();
const CRC_TABLE = new Uint32Array(256);

for (let n = 0; n < CRC_TABLE.length; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function compareNames(a: ZipEntry, b: ZipEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function createZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > 0xffff) throw new Error('Atom Pack has too many files for a ZIP archive');

  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of [...entries].sort(compareNames)) {
    const name = encoder.encode(entry.name);
    if (name.byteLength > 0xffff) throw new Error(`Atom Pack path is too long: ${entry.name}`);
    const deflated = new Uint8Array(deflateRawSync(entry.bytes, { level: 9 }));
    const compressed = deflated.byteLength < entry.bytes.byteLength ? deflated : entry.bytes;
    const method = compressed === deflated ? 8 : 0;
    const checksum = crc32(entry.bytes);

    const local = new Uint8Array(30 + name.byteLength + compressed.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, method, true);
    localView.setUint16(12, 0x0021, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, compressed.byteLength, true);
    localView.setUint32(22, entry.bytes.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(compressed, 30 + name.byteLength);
    localChunks.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(14, 0x0021, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, compressed.byteLength, true);
    centralView.setUint32(24, entry.bytes.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralChunks.push(central);
    localOffset += local.byteLength;
  }

  const central = concat(centralChunks);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, central.byteLength, true);
  endView.setUint32(16, localOffset, true);
  return concat([...localChunks, central, end]);
}
