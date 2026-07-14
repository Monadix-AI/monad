import type { SandboxPolicy, SandboxProcess, SandboxSpawnOptions, SandboxViolation } from '@monad/sdk-atom';

import { existsSync } from 'node:fs';

import { imagesDir } from '../../src/image.ts';
import { configureVmBackend, vmLauncher } from '../../src/index.ts';
import { configureVmToolchain } from '../../src/toolchain.ts';
import { toGuestPath } from '../../src/winpath.ts';

export type VmPolicy = SandboxPolicy;

export function guestPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? toGuestPath(path) : path;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function guestArg(path: string, platform: NodeJS.Platform = process.platform): string {
  return shellQuote(guestPath(path, platform));
}

export async function drainBytes(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  return stream ? await new Response(stream).text() : '';
}

export async function drainViolations(
  stream: ReadableStream<SandboxViolation> | undefined
): Promise<SandboxViolation[]> {
  if (!stream) return [];
  const values: SandboxViolation[] = [];
  for await (const violation of stream) values.push({ ...violation });
  return values;
}

export function spawnVm(
  argv: string[],
  policy: VmPolicy,
  agentId: string,
  options: Partial<SandboxSpawnOptions> = {}
): SandboxProcess {
  if (!vmLauncher.spawn) throw new Error('vm launcher has no spawn');
  return vmLauncher.spawn(argv, { sessionId: 's', agentId, ...options }, policy);
}

export async function runVm(
  argv: string[],
  policy: VmPolicy,
  agentId: string,
  options: Partial<SandboxSpawnOptions> = {}
): Promise<{ code: number; stdout: string }> {
  const process = spawnVm(argv, policy, agentId, options);
  const stdout = drainBytes(process.stdout);
  const code = await process.exited;
  return { code, stdout: await stdout };
}

export function runSh(script: string, policy: VmPolicy, agentId: string): Promise<{ code: number; stdout: string }> {
  return runVm(['sh', '-c', script], policy, agentId);
}

let preparePromise: Promise<void> | undefined;

export async function prepareRealVm(): Promise<void> {
  preparePromise ??= (async () => {
    configureVmToolchain({});
    configureVmBackend({ imageConsent: async () => true, idleTtlMs: 5_000, bootTimeoutMs: 600_000 });
    if (!existsSync(imagesDir())) throw new Error(`no base image in ${imagesDir()} — download it first`);
    await vmLauncher.prepare?.();
  })().catch((error) => {
    preparePromise = undefined;
    throw error;
  });
  await preparePromise;
}

export async function disposeRealVm(agentId: string): Promise<void> {
  await vmLauncher.disposeAgent?.(agentId);
}

export async function waitForHostFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(25);
  }
  throw new Error(`guest did not create host oracle ${path}`);
}
