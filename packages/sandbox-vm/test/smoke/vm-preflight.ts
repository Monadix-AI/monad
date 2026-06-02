#!/usr/bin/env bun

import type { ResolvedToolchain } from '../../src/toolchain.ts';

import { hypervPreflight } from '../../src/driver/hyperv.ts';
import { resolveVmToolchain } from '../../src/toolchain.ts';

export interface VmPreflightResult {
  ok: boolean;
  driver: 'qemu-kvm' | 'vfkit' | 'hyperv' | 'unsupported';
  detail?: string;
}

export function preflightResult(
  toolchain: Pick<ResolvedToolchain, 'hypervisor' | 'gvproxy' | 'kvm'>,
  platform: NodeJS.Platform = process.platform
): VmPreflightResult {
  if (platform === 'linux') {
    return toolchain.kvm
      ? { ok: true, driver: 'qemu-kvm' }
      : { ok: false, driver: 'qemu-kvm', detail: '/dev/kvm is not readable and writable' };
  }
  if (platform === 'darwin') return { ok: true, driver: 'vfkit' };
  if (platform === 'win32') return { ok: true, driver: 'hyperv' };
  return { ok: false, driver: 'unsupported', detail: `unsupported host ${platform}` };
}

async function main(): Promise<never> {
  try {
    const toolchain = await resolveVmToolchain();
    if (process.platform === 'win32') await hypervPreflight(toolchain.hypervisor);
    const result = preflightResult(toolchain);
    const report = { ...result, platform: process.platform, arch: process.arch };
    (result.ok ? process.stdout : process.stderr).write(`${JSON.stringify(report)}\n`);
    process.exit(result.ok ? 0 : 69);
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 2048);
    process.stderr.write(
      `${JSON.stringify({ ok: false, driver: 'unsupported', platform: process.platform, arch: process.arch, detail })}\n`
    );
    process.exit(69);
  }
}

if (import.meta.main) void main();
