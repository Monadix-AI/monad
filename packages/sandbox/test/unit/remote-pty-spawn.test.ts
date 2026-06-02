import type { SandboxLauncher, SandboxProcess, SandboxSpawnOptions, SandboxTerminal } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';
import { noneLauncher } from '@monad/sdk-atom';

import { configureSandboxLauncher, sandboxedPtySpawn } from '../../src/spawn.ts';

afterEach(() => configureSandboxLauncher(noneLauncher));

test('remote PTY forwards dimensions, merged output, and terminal controls', async () => {
  const writes: string[] = [];
  const resizes: [number, number][] = [];
  let closed = 0;
  let receivedOptions: SandboxSpawnOptions | undefined;
  const terminal: SandboxTerminal = {
    write(data) {
      writes.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
    },
    close() {
      closed++;
    },
    resize(cols, rows) {
      resizes.push([cols, rows]);
    }
  };
  const process: SandboxProcess = {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('ready'));
        controller.close();
      }
    }),
    terminal,
    exited: Promise.resolve(0),
    exitCode: 0,
    kill() {}
  };
  const launcher: SandboxLauncher = {
    kind: 'remote-test',
    descriptor: { name: 'Remote test', description: 'Remote PTY test launcher.' },
    spawn(_argv, options) {
      receivedOptions = options;
      return process;
    }
  };
  configureSandboxLauncher(launcher);
  const output: string[] = [];

  const proc = sandboxedPtySpawn(['sh'], {
    terminal: {
      cols: 80,
      rows: 24,
      data: (_handle, data) => output.push(new TextDecoder().decode(data))
    }
  });
  await proc.exited;
  await proc.terminal?.write('hello');
  await proc.terminal?.resize(120, 40);
  await proc.terminal?.close();

  expect(receivedOptions?.terminal).toEqual({ cols: 80, rows: 24 });
  expect(output).toEqual(['ready']);
  expect(writes).toEqual(['hello']);
  expect(resizes).toEqual([[120, 40]]);
  expect(closed).toBe(1);
});
