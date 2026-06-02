import { green, isHumanOutputEnabled, red } from './output.ts';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const REPLACE_LINE = '\r\x1b[2K';

export interface StatusLine {
  fail(message: string): void;
  success(message: string): void;
}

export interface StatusLineOptions {
  clearInterval?: (id: unknown) => void;
  enabled?: boolean;
  isTTY?: boolean;
  setInterval?: (callback: () => void, delay: number) => unknown;
  write?: (text: string) => void;
}

export function startStatusLine(message: string, options: StatusLineOptions = {}): StatusLine {
  const enabled = options.enabled ?? isHumanOutputEnabled();
  if (!enabled) return { fail() {}, success() {} };

  const isTTY = options.isTTY ?? !!process.stdout.isTTY;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  if (!isTTY) {
    write(`${message}\n`);
    return {
      fail: (finalMessage) => write(`${red('✖')} ${finalMessage}\n`),
      success: (finalMessage) => write(`${green('✓')} ${finalMessage}\n`)
    };
  }

  const schedule = options.setInterval ?? ((callback, delay) => globalThis.setInterval(callback, delay));
  const cancel = options.clearInterval ?? ((id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>));
  let frameIndex = 0;
  let finished = false;
  const render = () => {
    write(`${REPLACE_LINE}${SPINNER_FRAMES[frameIndex]} ${message}`);
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
  };
  render();
  const timer = schedule(render, 80);

  const finish = (icon: string, finalMessage: string) => {
    if (finished) return;
    finished = true;
    cancel(timer);
    write(`${REPLACE_LINE}${icon} ${finalMessage}\n`);
  };

  return {
    fail: (finalMessage) => finish(red('✖'), finalMessage),
    success: (finalMessage) => finish(green('✓'), finalMessage)
  };
}
