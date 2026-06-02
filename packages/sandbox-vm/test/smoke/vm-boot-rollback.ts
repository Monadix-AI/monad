#!/usr/bin/env bun

import { configureVmBackend, vmLauncher } from '../../src/index.ts';
import { configureVmToolchain } from '../../src/toolchain.ts';
import { waitForNoAgentResources } from './vm-resource-audit.ts';

async function main(): Promise<never> {
  const agentId = `p05-fault-${process.pid}-${Date.now()}`;
  configureVmToolchain({});
  configureVmBackend({ bootTimeoutMs: 1, imageConsent: async () => true, idleTtlMs: 1 });
  try {
    await vmLauncher.prepare?.();
    if (!vmLauncher.spawn) throw new Error('vm launcher has no spawn');
    const process = vmLauncher.spawn(['true'], { agentId, sessionId: 'p05-fault' }, { net: 'none' });
    const output = Promise.all([
      process.stdout ? new Response(process.stdout).arrayBuffer() : undefined,
      process.stderr ? new Response(process.stderr).arrayBuffer() : undefined
    ]);
    let rejected = false;
    try {
      await process.exited;
    } catch {
      rejected = true;
    }
    await output;
    if (!rejected) throw new Error('1ms readiness fault did not reject VM boot');
  } finally {
    await vmLauncher.disposeAgent?.(agentId);
  }
  await waitForNoAgentResources(agentId);
  process.stdout.write(`${JSON.stringify({ ok: true, fault: 'vsock-readiness', agentId })}\n`);
  process.exit(0);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
