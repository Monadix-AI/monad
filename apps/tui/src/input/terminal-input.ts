import type { TuiMouseButton, TuiMouseEvent } from './types.ts';

import { PassThrough } from 'node:stream';

const MOUSE_PREFIX = Buffer.from('\u001b[<');
const COMPLETE_MOUSE_BODY = /^(\d+);(\d+);(\d+)([Mm])/;
const INCOMPLETE_MOUSE_BODY = /^[\d;]*$/;

export interface DecodedTerminalInput {
  keyboard: Buffer;
  mouse: TuiMouseEvent[];
}

export const enableMouseTracking = () => '\u001b[?1000h\u001b[?1002h\u001b[?1006h';
export const disableMouseTracking = () => '\u001b[?1006l\u001b[?1002l\u001b[?1000l';

export class TerminalLifecycle {
  private active = false;
  private restored = false;

  constructor(
    private readonly input: { close: () => void },
    private readonly write: (value: string) => void
  ) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.write(enableMouseTracking());
  }

  restore(): void {
    if (this.restored) return;
    this.restored = true;
    if (this.active) this.write(disableMouseTracking());
    this.input.close();
  }
}

function buttonName(code: number): TuiMouseButton {
  if ((code & 64) !== 0) return (code & 1) === 0 ? 'wheel-up' : 'wheel-down';
  switch (code & 3) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    default:
      return 'none';
  }
}

function mouseEvent(code: number, column: number, row: number, terminator: string): TuiMouseEvent {
  const button = buttonName(code);
  const action =
    (code & 64) !== 0
      ? 'scroll'
      : terminator === 'm'
        ? 'release'
        : (code & 32) !== 0
          ? button === 'none'
            ? 'move'
            : 'drag'
          : 'press';
  return {
    action,
    button,
    column: Math.max(0, column - 1),
    ctrl: (code & 16) !== 0,
    meta: (code & 8) !== 0,
    row: Math.max(0, row - 1),
    shift: (code & 4) !== 0
  };
}

export class TerminalInputDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): DecodedTerminalInput {
    let input = Buffer.concat([this.pending, chunk]);
    this.pending = Buffer.alloc(0);
    const keyboard: Buffer[] = [];
    const mouse: TuiMouseEvent[] = [];

    while (input.length > 0) {
      const prefixAt = input.indexOf(MOUSE_PREFIX);
      if (prefixAt < 0) {
        keyboard.push(input);
        break;
      }
      if (prefixAt > 0) keyboard.push(input.subarray(0, prefixAt));
      input = input.subarray(prefixAt);
      const candidate = input.subarray(MOUSE_PREFIX.length).toString('utf8');
      const match = COMPLETE_MOUSE_BODY.exec(candidate);
      if (match) {
        const packet = MOUSE_PREFIX.length + Buffer.byteLength(match[0]);
        mouse.push(mouseEvent(Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? 'M'));
        input = input.subarray(packet);
        continue;
      }
      if (INCOMPLETE_MOUSE_BODY.test(candidate)) this.pending = input;
      else {
        keyboard.push(input.subarray(0, 1));
        input = input.subarray(1);
        continue;
      }
      break;
    }

    return { keyboard: Buffer.concat(keyboard), mouse };
  }
}

export class TerminalInputBridge extends PassThrough {
  readonly isTTY: boolean;
  private readonly decoder = new TerminalInputDecoder();
  private readonly mouseListeners = new Set<(event: TuiMouseEvent) => void>();
  private didClose = false;
  private readonly sourceData = (data: string | Buffer) => {
    const decoded = this.decoder.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    if (decoded.keyboard.length > 0) this.write(decoded.keyboard);
    for (const event of decoded.mouse) {
      for (const listener of this.mouseListeners) listener(event);
    }
  };

  constructor(private readonly source: NodeJS.ReadStream) {
    super();
    this.isTTY = source.isTTY === true;
    source.on('data', this.sourceData);
  }

  setRawMode(enabled: boolean): this {
    this.source.setRawMode?.(enabled);
    return this;
  }

  ref(): this {
    (this.source as NodeJS.ReadStream & { ref?: () => void }).ref?.();
    return this;
  }

  unref(): this {
    (this.source as NodeJS.ReadStream & { unref?: () => void }).unref?.();
    return this;
  }

  onMouse(listener: (event: TuiMouseEvent) => void): () => void {
    this.mouseListeners.add(listener);
    return () => this.mouseListeners.delete(listener);
  }

  close(): void {
    if (this.didClose) return;
    this.didClose = true;
    this.source.off('data', this.sourceData);
    this.source.setRawMode?.(false);
    this.source.pause();
    (this.source as NodeJS.ReadStream & { unref?: () => void }).unref?.();
    this.source.destroy();
    this.mouseListeners.clear();
    this.end();
  }
}
