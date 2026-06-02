import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { portsForOffset, replacePortLines } from '../../dev-init/ports.ts';
import { rotateDevPorts } from '../../dev-ports.ts';

test('rotateDevPorts selects the next complete port set and atomically persists it', async () => {
  const root = '/repo';
  const envPath = join(root, '.env.local');
  const original = 'MONAD_HOME=/repo/.dev/.monad\nMONAD_PORT=52010\nWEB_PORT=3110\nCUSTOM=value\n';
  const writes: Array<{ path: string; text: string }> = [];
  const checked: number[] = [];

  const result = await rotateDevPorts(root, {
    isPortAvailable: async (port) => {
      checked.push(port);
      return port !== 53011;
    },
    readText: async (path) => {
      expect(path).toBe(envPath);
      return original;
    },
    writeTextAtomically: async (path, text) => {
      writes.push({ path, text });
    }
  });

  expect(result).toEqual({ offset: 12, ports: portsForOffset(12) });
  expect(writes).toEqual([{ path: envPath, text: replacePortLines(original, portsForOffset(12)) }]);
  expect(checked).toEqual([
    ...Object.values(portsForOffset(11)).map(Number),
    ...Object.values(portsForOffset(12)).map(Number)
  ]);
});
