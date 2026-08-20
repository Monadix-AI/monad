import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QmpClient } from '../../src/driver/qemu.ts';

test('QMP client negotiates capabilities and correlates bounded commands', async () => {
  const path = join(tmpdir(), `qmp-${process.pid}-${Date.now()}.sock`);
  const commands: string[] = [];
  const server = createServer((socket) => {
    socket.write(`${JSON.stringify({ QMP: { version: { qemu: { major: 9 } } } })}\r\n`);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const command = JSON.parse(line) as { execute: string };
        commands.push(command.execute);
        socket.write(
          `${JSON.stringify({ return: command.execute === 'query-status' ? { status: 'running' } : {} })}\r\n`
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const client = await QmpClient.open(path);
  try {
    expect(await client.command('query-status')).toEqual({ status: 'running' });
    expect(commands).toEqual(['qmp_capabilities', 'query-status']);
  } finally {
    client.close();
    server.close();
  }
});
