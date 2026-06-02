#!/usr/bin/env bun

import { rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

import { parseEnvFile } from './dev-init/env.ts';
import {
  configuredPortOffset,
  nextAvailablePorts,
  portOffset,
  replacePortLines,
  type WorktreePorts
} from './dev-init/ports.ts';

export interface DevPortRotationDeps {
  isPortAvailable(port: number): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeTextAtomically(path: string, text: string): Promise<void>;
}

export interface DevPortRotation {
  offset: number;
  ports: WorktreePorts;
}

export async function isTcpPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolveAvailability) => {
    const server = createServer();
    const finish = (available: boolean): void => {
      server.removeAllListeners();
      resolveAvailability(available);
    };
    server.once('error', () => finish(false));
    server.listen({ exclusive: true, host: '127.0.0.1', port }, () => {
      server.close((error) => finish(!error));
    });
    server.unref();
  });
}

export async function writeTextAtomically(path: string, text: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, text, 'utf8');
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function rotateDevPorts(
  root: string,
  deps: DevPortRotationDeps = {
    isPortAvailable: isTcpPortAvailable,
    readText: async (path) => Bun.file(path).text(),
    writeTextAtomically
  }
): Promise<DevPortRotation> {
  const envPath = join(root, '.env.local');
  const envText = await deps.readText(envPath);
  const parsed = parseEnvFile(envText);
  const currentOffset = configuredPortOffset(parsed) ?? portOffset(root);
  const next = await nextAvailablePorts(currentOffset, deps.isPortAvailable);
  if (!next) throw new Error('no complete development port set is available');
  await deps.writeTextAtomically(envPath, replacePortLines(envText, next.ports));
  return next;
}

async function main(): Promise<void> {
  if (!process.argv.slice(2).includes('--rotate')) {
    process.stderr.write('usage: mise run dev:ports -- --rotate\n');
    process.exit(64);
  }
  const root = resolve(import.meta.dir, '..');
  try {
    const result = await rotateDevPorts(root);
    process.stdout.write(`Development ports rotated to offset ${result.offset}.\n`);
    for (const [key, value] of Object.entries(result.ports)) process.stdout.write(`  ${key}=${value}\n`);
    process.stdout.write('mise will load the new values at the next shell prompt.\n');
  } catch (error) {
    process.stderr.write(
      `Unable to rotate development ports: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}

if (import.meta.main) await main();
