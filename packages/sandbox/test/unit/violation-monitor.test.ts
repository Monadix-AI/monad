import type { Subprocess } from 'bun';

import { expect, test } from 'bun:test';

import { parseSeatbeltViolation, type SandboxViolation, startViolationMonitor } from '../../src/violation-monitor.ts';

test('parses a Seatbelt deny line into operation + target + process', () => {
  const v = parseSeatbeltViolation('Sandbox: bash(52413) deny(1) file-read-data /Users/x/.ssh/id_rsa');
  expect(v).toEqual({ operation: 'file-read-data', target: '/Users/x/.ssh/id_rsa', process: 'bash', pid: 52413 });
});

test('parses a network deny (no filesystem target)', () => {
  const v = parseSeatbeltViolation('Sandbox: curl(9) deny(1) network-outbound 93.184.216.34:443');
  expect(v?.operation).toBe('network-outbound');
  expect(v?.target).toBe('93.184.216.34:443');
});

test('returns null for a non-deny log line', () => {
  expect(parseSeatbeltViolation('some unrelated log message')).toBeNull();
  expect(parseSeatbeltViolation('Sandbox: allow file-read-data /etc/hosts')).toBeNull();
});

test('startViolationMonitor delivers parsed denies from the stream, no-ops when no spawner', async () => {
  const lines = [
    JSON.stringify({ eventMessage: 'Sandbox: bash(1) deny(1) file-read-data /Users/x/.aws/credentials' }),
    'not json but a deny(2) network-outbound 10.0.0.1:22',
    JSON.stringify({ eventMessage: 'irrelevant' })
  ].join('\n');

  const fakeProc = {
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(lines));
        c.close();
      }
    }),
    kill() {}
  } as unknown as Subprocess<'ignore', 'pipe', 'pipe'>;

  const got: SandboxViolation[] = [];
  const mon = startViolationMonitor({ onViolation: (v) => got.push(v), spawn: () => fakeProc });
  await Bun.sleep(20); // let the stream drain
  mon.stop();

  expect(got.map((v) => v.operation)).toEqual(['file-read-data', 'network-outbound']);
  expect(got[0]?.target).toBe('/Users/x/.aws/credentials');
});
