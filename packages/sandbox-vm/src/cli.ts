#!/usr/bin/env bun
// msvm — the VM-sandbox debug CLI.
//   msvm doctor            resolve + report the platform toolchain and image status
//   msvm setup             Windows only: register the hvsock service ports (run from an ELEVATED shell)
//   msvm run -- <argv…>    boot a VM (net:none) and run argv inside it, streaming output
//
// A thin harness over the launcher for local iteration without the daemon. `run` auto-approves the
// image download (debug only); the daemon gates it on a real user prompt.

import { hvsockSetupPortSpec } from './driver/hyperv.ts';
import { configureVmBackend, vmLauncher } from './index.ts';
import { resolveVmToolchain, vmDir } from './toolchain.ts';

async function doctor(): Promise<number> {
  process.stdout.write(`vmDir: ${vmDir()}\n`);
  try {
    const tc = await resolveVmToolchain();
    process.stdout.write(`hypervisor: ${tc.hypervisor}\n`);
    process.stdout.write(`gvproxy:    ${tc.gvproxy}\n`);
    if (tc.virtiofsd) process.stdout.write(`virtiofsd:  ${tc.virtiofsd}\n`);
    if (tc.firmware) process.stdout.write(`firmware:   ${tc.firmware}\n`);
    if (tc.kvm !== undefined) process.stdout.write(`kvm:        ${tc.kvm}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`toolchain not ready: ${err instanceof Error ? err.message : String(err)}\n`);
    return 69; // EX_UNAVAILABLE
  }
}

// One-time Windows bootstrap: register the fixed hvsock service-port range under
// HKLM\...\GuestCommunicationServices. HKLM writes need an elevated shell; every later VM boot is
// admin-free (listeners are VMID-pinned, ports are shared across VMs).
async function setup(): Promise<number> {
  if (process.platform !== 'win32') {
    process.stderr.write('msvm setup is Windows-only (registers Hyper-V hvsock service ports)\n');
    return 64;
  }
  const tc = await resolveVmToolchain();
  const proc = Bun.spawn([tc.hypervisor, 'setup', '--ports', hvsockSetupPortSpec()], {
    stdout: 'inherit',
    stderr: 'inherit'
  });
  return await proc.exited;
}

async function run(argv: string[]): Promise<number> {
  configureVmBackend({ imageConsent: async () => true }); // debug: auto-approve the image pull
  await vmLauncher.prepare?.();
  if (!vmLauncher.spawn) throw new Error('vm launcher has no spawn');
  const proc = vmLauncher.spawn(argv, { sessionId: 'msvm-debug' }, { net: 'none' });
  if (proc.stdout) {
    await proc.stdout.pipeTo(new WritableStream({ write: (c) => void process.stdout.write(c) }));
  }
  return await proc.exited;
}

async function main(): Promise<never> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'doctor') process.exit(await doctor());
  if (cmd === 'setup') process.exit(await setup());
  if (cmd === 'run') {
    const sep = rest.indexOf('--');
    const argv = sep >= 0 ? rest.slice(sep + 1) : rest;
    if (argv.length === 0) {
      process.stderr.write('usage: msvm run -- <argv…>\n');
      process.exit(64);
    }
    process.exit(await run(argv));
  }
  process.stderr.write('usage: msvm <doctor|setup|run -- argv…>\n');
  process.exit(64);
}

void main();
