const CRLF = '\r\n';

export function encodeSimple(s: string): Buffer {
  return Buffer.from(`+${s}${CRLF}`);
}

export function encodeError(msg: string, prefix = 'ERR'): Buffer {
  return Buffer.from(`-${prefix} ${msg}${CRLF}`);
}

export function encodeInteger(n: number): Buffer {
  return Buffer.from(`:${n}${CRLF}`);
}

export function encodeBulk(s: string | Buffer | null): Buffer {
  if (s === null) return Buffer.from(`$-1${CRLF}`);
  const data = typeof s === 'string' ? Buffer.from(s) : s;
  return Buffer.concat([Buffer.from(`$${data.length}${CRLF}`), data, Buffer.from(CRLF)]);
}

export function encodeArray(items: (string | Buffer | null)[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${items.length}${CRLF}`)];
  for (const item of items) parts.push(encodeBulk(item));
  return Buffer.concat(parts);
}

export function encodeNullArray(): Buffer {
  return Buffer.from(`*-1${CRLF}`);
}

export type RespValue = string | Buffer | number | null | RespValue[];

export function encodeNested(value: RespValue): Buffer {
  if (Array.isArray(value)) {
    const parts: Buffer[] = [Buffer.from(`*${value.length}${CRLF}`)];
    for (const item of value) parts.push(encodeNested(item));
    return Buffer.concat(parts);
  }
  if (typeof value === 'number') return encodeInteger(value);
  return encodeBulk(value);
}

/** RESP3 map type (%): used for the HELLO reply so Bun.redis enters RESP3 mode. */
export function encodeMap(pairs: [string, string | number | null][]): Buffer {
  const parts: Buffer[] = [Buffer.from(`%${pairs.length}${CRLF}`)];
  for (const [k, v] of pairs) {
    parts.push(encodeBulk(k));
    if (typeof v === 'number') parts.push(encodeInteger(v));
    else parts.push(encodeBulk(v));
  }
  return Buffer.concat(parts);
}

/** RESP3 push type (>): used for pub/sub messages and subscription confirmations. */
export function encodePush(items: (string | number | null)[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`>${items.length}${CRLF}`)];
  for (const item of items) {
    if (typeof item === 'number') parts.push(encodeInteger(item));
    else parts.push(encodeBulk(item));
  }
  return Buffer.concat(parts);
}

export interface ParsedCommand {
  args: string[];
  rest: Buffer;
}

export function parseCommand(buf: Buffer): ParsedCommand | null {
  if (buf.length === 0) return null;

  const firstByte = buf[0];

  // Standard RESP2 array (*N\r\n …)
  if (firstByte === 0x2a /* * */) return parseArray(buf);

  // Inline command (e.g. PING\r\n)
  const crlfIdx = indexOfCRLF(buf, 0);
  if (crlfIdx === -1) return null;
  const line = buf.subarray(0, crlfIdx).toString().trim();
  if (line.length === 0) return null;
  const args = line.split(/\s+/).filter(Boolean);
  return { args, rest: buf.subarray(crlfIdx + 2) };
}

function parseArray(buf: Buffer): ParsedCommand | null {
  const crlfIdx = indexOfCRLF(buf, 1);
  if (crlfIdx === -1) return null;
  const count = Number.parseInt(buf.subarray(1, crlfIdx).toString(), 10);
  if (Number.isNaN(count) || count <= 0) return null;

  const args: string[] = [];
  let pos = crlfIdx + 2;

  for (let i = 0; i < count; i++) {
    if (pos >= buf.length) return null;
    if (buf[pos] !== 0x24 /* $ */) return null;

    const lenEndIdx = indexOfCRLF(buf, pos + 1);
    if (lenEndIdx === -1) return null;
    const len = Number.parseInt(buf.subarray(pos + 1, lenEndIdx).toString(), 10);
    if (Number.isNaN(len) || len < 0) return null;

    const dataStart = lenEndIdx + 2;
    if (dataStart + len + 2 > buf.length) return null;

    args.push(buf.subarray(dataStart, dataStart + len).toString());
    pos = dataStart + len + 2;
  }

  return { args, rest: buf.subarray(pos) };
}

function indexOfCRLF(buf: Buffer, start: number): number {
  for (let i = start; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}
