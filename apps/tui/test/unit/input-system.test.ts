import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';

import { ActionRegistry } from '../../src/input/actions.ts';
import { FocusRegistry } from '../../src/input/focus.ts';
import { InputRouter } from '../../src/input/router.ts';
import {
  disableMouseTracking,
  enableMouseTracking,
  TerminalInputBridge,
  TerminalInputDecoder,
  TerminalLifecycle
} from '../../src/input/terminal-input.ts';

describe('TerminalInputDecoder', () => {
  test('removes SGR mouse packets and preserves surrounding keyboard input', () => {
    const decoder = new TerminalInputDecoder();
    const result = decoder.push(Buffer.from('a\u001b[<0;12;5Mb'));

    expect(result.keyboard.toString()).toBe('ab');
    expect(result.mouse).toEqual([
      {
        action: 'press',
        button: 'left',
        column: 11,
        ctrl: false,
        meta: false,
        row: 4,
        shift: false
      }
    ]);
  });

  test('buffers mouse packets split across chunks', () => {
    const decoder = new TerminalInputDecoder();

    const first = decoder.push(Buffer.from('x\u001b[<64;3'));
    const second = decoder.push(Buffer.from(';9My'));

    expect(first.keyboard.toString()).toBe('x');
    expect(first.mouse).toEqual([]);
    expect(second.keyboard.toString()).toBe('y');
    expect(second.mouse[0]).toMatchObject({ action: 'scroll', button: 'wheel-up', column: 2, row: 8 });
  });

  test('passes non-mouse CSI sequences through unchanged', () => {
    const decoder = new TerminalInputDecoder();
    const result = decoder.push(Buffer.from('\u001b[1;2A'));

    expect(result.keyboard.toString()).toBe('\u001b[1;2A');
    expect(result.mouse).toEqual([]);
  });

  test('decodes modified drag and release packets', () => {
    const decoder = new TerminalInputDecoder();
    const result = decoder.push(Buffer.from('\u001b[<52;20;10M\u001b[<4;20;10m'));

    expect(result.mouse).toEqual([
      expect.objectContaining({ action: 'drag', button: 'left', column: 19, ctrl: true, row: 9, shift: true }),
      expect.objectContaining({ action: 'release', button: 'left', column: 19, row: 9, shift: true })
    ]);
  });

  test('preserves bracketed paste packets for Ink', () => {
    const decoder = new TerminalInputDecoder();
    const packet = '\u001b[200~line 1\nline 2\u001b[201~';
    expect(decoder.push(Buffer.from(packet)).keyboard.toString()).toBe(packet);
  });
});

describe('TerminalInputBridge', () => {
  test('emits mouse events without forwarding their bytes to Ink', async () => {
    const source = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
    source.isTTY = true;
    source.setRawMode = () => {};
    const bridge = new TerminalInputBridge(source as unknown as NodeJS.ReadStream);
    const keyboard: Buffer[] = [];
    const mouse: unknown[] = [];
    bridge.on('data', (data) => keyboard.push(Buffer.from(data)));
    bridge.onMouse((event) => mouse.push(event));

    source.write(Buffer.from('k\u001b[<65;8;4M'));
    await Bun.sleep(0);

    expect(Buffer.concat(keyboard).toString()).toBe('k');
    expect(mouse[0]).toMatchObject({ action: 'scroll', button: 'wheel-down', column: 7, row: 3 });
    bridge.close();
  });

  test('uses symmetric terminal mouse tracking sequences', () => {
    expect(enableMouseTracking()).toBe('\u001b[?1000h\u001b[?1002h\u001b[?1006h');
    expect(disableMouseTracking()).toBe('\u001b[?1006l\u001b[?1002l\u001b[?1000l');
  });

  test('restores cooked mode when the bridge closes', () => {
    const rawModes: boolean[] = [];
    const source = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
    source.isTTY = true;
    source.setRawMode = (enabled) => rawModes.push(enabled);
    const bridge = new TerminalInputBridge(source as unknown as NodeJS.ReadStream);

    bridge.setRawMode(true);
    bridge.close();

    expect(rawModes).toEqual([true, false]);
  });

  test('proxies the TTY lifecycle methods Ink requires', () => {
    const calls: string[] = [];
    const source = new PassThrough() as PassThrough & {
      isTTY: boolean;
      ref: () => void;
      setRawMode: (enabled: boolean) => void;
      unref: () => void;
    };
    source.isTTY = true;
    source.setRawMode = () => {};
    source.ref = () => calls.push('ref');
    source.unref = () => calls.push('unref');
    const bridge = new TerminalInputBridge(source as unknown as NodeJS.ReadStream);

    bridge.ref();
    bridge.unref();
    bridge.close();

    expect(calls).toEqual(['ref', 'unref', 'unref']);
    expect(source.isPaused()).toBe(true);
    expect(source.destroyed).toBe(true);
  });
});

describe('TerminalLifecycle', () => {
  test('restores mouse tracking and input exactly once', () => {
    const output: string[] = [];
    let closes = 0;
    const lifecycle = new TerminalLifecycle({ close: () => closes++ }, (value) => output.push(value));

    lifecycle.start();
    lifecycle.restore();
    lifecycle.restore();

    expect(output).toEqual([enableMouseTracking(), disableMouseTracking()]);
    expect(closes).toBe(1);
  });
});

describe('ActionRegistry', () => {
  test('runs the highest-priority enabled binding', () => {
    const registry = new ActionRegistry();
    const calls: string[] = [];
    registry.register({ action: 'global.help', priority: 0, run: () => calls.push('global') });
    registry.register({ action: 'modal.help', priority: 300, run: () => calls.push('modal') });

    expect(registry.dispatch((binding) => binding.action.endsWith('help'))).toBe(true);
    expect(calls).toEqual(['modal']);
  });

  test('skips disabled bindings', () => {
    const registry = new ActionRegistry();
    const calls: string[] = [];
    registry.register({ action: 'modal.close', enabled: false, priority: 300, run: () => calls.push('modal') });
    registry.register({ action: 'route.back', priority: 100, run: () => calls.push('route') });

    registry.dispatch((binding) => binding.action.endsWith('close') || binding.action.endsWith('back'));
    expect(calls).toEqual(['route']);
  });
});

describe('InputRouter', () => {
  test('routes approval and modal input before focused and global handlers', () => {
    const router = new InputRouter();
    const calls: string[] = [];
    router.register('global', () => {
      calls.push('global');
      return true;
    });
    router.register('control', () => {
      calls.push('control');
      return true;
    });
    router.register('approval', () => {
      calls.push('approval');
      return true;
    });

    expect(router.route({ input: 'x', key: {} })).toBe(true);
    expect(calls).toEqual(['approval']);
  });
});

describe('FocusRegistry', () => {
  test('cycles only through active regions in order', () => {
    const registry = new FocusRegistry();
    registry.register({ active: true, height: 4, id: 'content', order: 20, width: 20, x: 10, y: 0 });
    registry.register({ active: true, height: 4, id: 'nav', order: 10, width: 10, x: 0, y: 0 });
    registry.register({ active: false, height: 4, id: 'hidden', order: 15, width: 10, x: 0, y: 5 });

    expect(registry.next()).toBe('nav');
    expect(registry.next()).toBe('content');
    expect(registry.previous()).toBe('nav');
  });

  test('hit-tests the topmost active region', () => {
    const registry = new FocusRegistry();
    registry.register({ active: true, height: 10, id: 'base', order: 10, width: 20, x: 0, y: 0 });
    registry.register({ active: true, height: 3, id: 'modal', order: 300, width: 8, x: 3, y: 2 });

    expect(registry.hit(4, 3)?.id).toBe('modal');
    expect(registry.hit(15, 8)?.id).toBe('base');
  });
});
