import type { ExternalAgentAppServerConnection } from '@/services/external-agent/types.ts';

import { randomBytes } from 'node:crypto';

// Codex's `unix://` listener speaks WebSocket over the socket with a standard HTTP Upgrade — but Bun's
// built-in `ws+unix://` client advertises `permessage-deflate`, which codex's unix path mishandles and
// drops right after the 101. So we hand-roll a minimal WebSocket client over a raw AF_UNIX socket that
// offers no extensions (uncompressed frames), which interoperates with codex cleanly. One JSON-RPC
// message per text frame, per the protocol.

interface ConnectAppServerUnixOptions {
  /** Absolute path of the AF_UNIX socket the child is listening on (chosen by the daemon). */
  socketPath: string;
  /** Each inbound WebSocket text frame is one JSON-RPC message. */
  onMessage: (text: string) => void;
  onClose: () => void;
  timeoutMs: number;
}

type Bytes = Uint8Array<ArrayBufferLike>;

interface RawSocket {
  write(data: Uint8Array | string): number;
  end(): void;
}

/** Mask and frame a UTF-8 text payload as a single final client WebSocket frame (opcode 0x1). Client
 *  frames MUST be masked per RFC 6455. */
function encodeTextFrame(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const mask = randomBytes(4);
  const len = payload.length;
  const header: number[] = [0x81];
  if (len < 126) header.push(0x80 | len);
  else if (len < 0x10000) header.push(0x80 | 126, (len >> 8) & 0xff, len & 0xff);
  else {
    header.push(0x80 | 127);
    for (let i = 7; i >= 0; i--) header.push(Number((BigInt(len) >> BigInt(i * 8)) & 0xffn));
  }
  const out = new Uint8Array(header.length + 4 + len);
  out.set(header, 0);
  out.set(mask, header.length);
  for (let i = 0; i < len; i++) out[header.length + 4 + i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  return out;
}

function encodeControlFrame(opcode: number): Uint8Array {
  // Empty-payload masked control frame (close 0x8 / pong 0xA).
  const mask = randomBytes(4);
  return new Uint8Array([0x80 | opcode, 0x80, ...mask]);
}

interface ParsedFrame {
  opcode: number;
  fin: boolean;
  payload: Bytes;
}

/** Parse as many complete server frames (unmasked) as `buffer` holds; return them plus the unconsumed
 *  tail so a partial frame is carried to the next read. */
function parseFrames(buffer: Bytes): { frames: ParsedFrame[]; rest: Bytes } {
  const frames: ParsedFrame[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset] ?? 0;
    const b1 = buffer[offset + 1] ?? 0;
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let cursor = offset + 2;
    if (len === 126) {
      if (cursor + 2 > buffer.length) break;
      len = ((buffer[cursor] ?? 0) << 8) | (buffer[cursor + 1] ?? 0);
      cursor += 2;
    } else if (len === 127) {
      if (cursor + 8 > buffer.length) break;
      len = Number(new DataView(buffer.buffer, buffer.byteOffset + cursor, 8).getBigUint64(0));
      cursor += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (cursor + maskLen + len > buffer.length) break;
    let payload = buffer.slice(cursor + maskLen, cursor + maskLen + len);
    if (masked) {
      const mask = buffer.slice(cursor, cursor + 4);
      payload = payload.map((byte, i) => byte ^ (mask[i % 4] ?? 0));
    }
    frames.push({ opcode, fin, payload });
    offset = cursor + maskLen + len;
  }
  return { frames, rest: buffer.slice(offset) };
}

function concat(a: Bytes, b: Bytes): Bytes {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Dial a codex-style `unix://` app-server: connect the raw socket (retrying until the child is
 * listening or the timeout elapses), perform the WebSocket Upgrade handshake, then expose the
 * transport-neutral `ExternalAgentAppServerConnection`. Text frames are delivered to `onMessage`; pings
 * are answered; a server close or socket drop fires `onClose`.
 */
export async function connectAppServerUnix(
  opts: ConnectAppServerUnixOptions
): Promise<ExternalAgentAppServerConnection> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await handshake(opts, deadline);
    } catch (error) {
      lastError = error;
      await Bun.sleep(80); // socket not listening yet, or mid-bind — retry
    }
  }
  throw new Error(`app-server unix transport: could not connect within timeout (${String(lastError ?? 'unknown')})`);
}

function handshake(opts: ConnectAppServerUnixOptions, deadline: number): Promise<ExternalAgentAppServerConnection> {
  return new Promise<ExternalAgentAppServerConnection>((resolve, reject) => {
    let phase: 'handshake' | 'open' | 'closed' = 'handshake';
    let inbound: Bytes = new Uint8Array(0);
    let fragmentOpcode = 0;
    let fragment: Bytes = new Uint8Array(0);
    const key = randomBytes(16).toString('base64');
    const timer = setTimeout(
      () => {
        if (phase === 'handshake') reject(new Error('app-server unix transport: handshake timed out'));
      },
      Math.max(1, deadline - Date.now())
    );

    const raiseClose = (): void => {
      if (phase === 'closed') return;
      const wasOpen = phase === 'open';
      phase = 'closed';
      clearTimeout(timer);
      if (wasOpen) opts.onClose();
    };

    void (Bun as unknown as { connect(o: unknown): Promise<unknown> })
      .connect({
        unix: opts.socketPath,
        socket: {
          open(socket: RawSocket) {
            socket.write(
              'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
                `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
            );
          },
          data(socket: RawSocket, chunk: Uint8Array) {
            inbound = concat(inbound, chunk);
            if (phase === 'handshake') {
              const text = new TextDecoder().decode(inbound);
              const end = text.indexOf('\r\n\r\n');
              if (end < 0) return;
              if (!/^HTTP\/1\.1 101/i.test(text)) {
                clearTimeout(timer);
                reject(new Error(`app-server unix transport: expected 101, got "${text.slice(0, 40)}"`));
                socket.end();
                return;
              }
              phase = 'open';
              clearTimeout(timer);
              inbound = inbound.slice(end + 4);
              resolve({
                send: (frame) => socket.write(encodeTextFrame(frame)),
                close: () => {
                  if (phase === 'open') socket.write(encodeControlFrame(0x8));
                  phase = 'closed';
                  socket.end();
                }
              });
            }
            if (phase !== 'open') return;
            const { frames, rest } = parseFrames(inbound);
            inbound = rest;
            for (const f of frames) {
              if (f.opcode === 0x9) {
                socket.write(encodeControlFrame(0xa)); // ping → pong
                continue;
              }
              if (f.opcode === 0x8) {
                raiseClose();
                socket.end();
                return;
              }
              if (f.opcode === 0x0) {
                fragment = concat(fragment, f.payload);
                if (f.fin) {
                  if (fragmentOpcode === 0x1) opts.onMessage(new TextDecoder().decode(fragment));
                  fragment = new Uint8Array(0);
                  fragmentOpcode = 0;
                }
                continue;
              }
              if (!f.fin) {
                fragmentOpcode = f.opcode;
                fragment = f.payload;
                continue;
              }
              if (f.opcode === 0x1) opts.onMessage(new TextDecoder().decode(f.payload));
            }
          },
          error() {
            if (phase === 'handshake') {
              clearTimeout(timer);
              reject(new Error('app-server unix transport: socket error'));
            } else raiseClose();
          },
          close() {
            if (phase === 'handshake') {
              clearTimeout(timer);
              reject(new Error('app-server unix transport: socket closed during handshake'));
            } else raiseClose();
          }
        }
      })
      .catch((error: unknown) => {
        if (phase === 'handshake') {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
  });
}
