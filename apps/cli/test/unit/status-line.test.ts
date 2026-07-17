import { expect, test } from 'bun:test';

import { startStatusLine } from '../../src/lib/status-line.ts';

test('TTY status replaces the spinner with one success line', () => {
  const writes: string[] = [];
  let tick = () => {};
  const status = startStatusLine('Restarting Monad…', {
    clearInterval: (id) => writes.push(`clear:${id}`),
    enabled: true,
    isTTY: true,
    setInterval: (callback) => {
      tick = callback;
      return 7;
    },
    write: (text) => writes.push(text)
  });

  tick();
  status.success('Monad restarted');

  expect(writes).toEqual([
    '\r\x1b[2K⠋ Restarting Monad…',
    '\r\x1b[2K⠙ Restarting Monad…',
    'clear:7',
    '\r\x1b[2K✓ Monad restarted\n'
  ]);
});

test('non-TTY status emits ordinary progress and success lines', () => {
  const writes: string[] = [];
  const status = startStatusLine('Restarting Monad…', {
    enabled: true,
    isTTY: false,
    write: (text) => writes.push(text)
  });

  status.success('Monad restarted');

  expect(writes).toEqual(['Restarting Monad…\n', '✓ Monad restarted\n']);
});

test('disabled status emits nothing', () => {
  const writes: string[] = [];
  const status = startStatusLine('Restarting Monad…', {
    enabled: false,
    isTTY: true,
    write: (text) => writes.push(text)
  });

  status.success('Monad restarted');

  expect(writes).toEqual([]);
});
