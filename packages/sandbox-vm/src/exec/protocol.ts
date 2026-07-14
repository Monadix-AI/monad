export const VSOCK_PROTOCOL_VERSION = 3;
export const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;
export const MAX_STREAM_FRAME_BYTES = 64 * 1024;

export enum HostFrameKind {
  Start = 1,
  Stdin = 2,
  CloseStdin = 3,
  Signal = 4,
  Resize = 5
}

export enum GuestFrameKind {
  Started = 16,
  Stdout = 17,
  Stderr = 18,
  Error = 19,
  Exit = 20,
  Unsupported = 21,
  Violation = 22
}

export interface VsockFrame {
  kind: number;
  payload: Buffer;
}

const STREAM_KINDS = new Set<number>([HostFrameKind.Stdin, GuestFrameKind.Stdout, GuestFrameKind.Stderr]);

function frameLimit(kind: number): number {
  return STREAM_KINDS.has(kind) ? MAX_STREAM_FRAME_BYTES : MAX_CONTROL_FRAME_BYTES;
}

function assertFrameLength(kind: number, length: number): void {
  const limit = frameLimit(kind);
  if (length <= limit) return;
  const label = STREAM_KINDS.has(kind) ? 'stream' : 'control';
  throw new Error(`vsock protocol: ${label} frame exceeds ${limit} bytes`);
}

export function encodeFrame(kind: number, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()): Buffer {
  assertFrameLength(kind, payload.byteLength);
  const frame = Buffer.allocUnsafe(5 + payload.byteLength);
  frame[0] = kind;
  frame.writeUInt32BE(payload.byteLength, 1);
  frame.set(payload, 5);
  return frame;
}

export class FrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Uint8Array): VsockFrame[] {
    if (chunk.byteLength > 0) this.buffered = Buffer.concat([this.buffered, chunk]);
    const frames: VsockFrame[] = [];
    while (this.buffered.byteLength >= 5) {
      const kind = this.buffered[0] as number;
      const length = this.buffered.readUInt32BE(1);
      assertFrameLength(kind, length);
      if (this.buffered.byteLength < 5 + length) break;
      frames.push({ kind, payload: Buffer.from(this.buffered.subarray(5, 5 + length)) });
      this.buffered = this.buffered.subarray(5 + length);
    }
    return frames;
  }
}

const SIGNALS: Readonly<Record<string, number>> = {
  HUP: 1,
  INT: 2,
  QUIT: 3,
  KILL: 9,
  TERM: 15,
  CONT: 18,
  STOP: 19,
  TSTP: 20
};

export function normalizeSignal(signal: number | string | undefined): number {
  if (signal === undefined) return SIGNALS.TERM as number;
  if (typeof signal === 'number') {
    if (Number.isInteger(signal) && signal >= 1 && signal <= 64) return signal;
    throw new Error(`vsock protocol: unsupported signal ${signal}`);
  }
  const normalized = signal.toUpperCase().replace(/^SIG/, '');
  const value = SIGNALS[normalized];
  if (value !== undefined) return value;
  throw new Error(`vsock protocol: unsupported signal ${signal}`);
}
