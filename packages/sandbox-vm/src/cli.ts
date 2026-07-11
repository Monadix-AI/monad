#!/usr/bin/env bun
// msvm — the VM-sandbox debug CLI.
//   msvm doctor            resolve + report the vfkit/gvproxy toolchain and image status
//   msvm run -- <argv…>    boot a VM (net:none) and run argv inside it, streaming output
//
// A thin harness over the launcher for local iteration without the daemon. `run` auto-approves the
// image download (debug only); the daemon gates it on a real user prompt.

import { configureVmBackend, vmLauncher } from './index.ts';
import { resolveVmToolchain, vmDir } from './toolchain.ts';

async function doctor(): Promise<number> {
  process.stdout.write(`vmDir: ${vmDir()}\n`);
  try {
    const tc = await resolveVmToolchain();
    process.stdout.write(`vfkit:   ${tc.vfkit}\n`);
    process.stdout.write(`gvproxy: ${tc.gvproxy}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`toolchain not ready: ${err instanceof Error ? err.message : String(err)}\n`);
    return 69; // EX_UNAVAILABLE
  }
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
  if (cmd === 'run') {
    const sep = rest.indexOf('--');
    const argv = sep >= 0 ? rest.slice(sep + 1) : rest;
    if (argv.length === 0) {
      process.stderr.write('usage: msvm run -- <argv…>\n');
      process.exit(64);
    }
    process.exit(await run(argv));
  }
  process.stderr.write('usage: msvm <doctor|run -- argv…>\n');
  process.exit(64);
}

void main();
