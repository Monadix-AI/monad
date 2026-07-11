import type { HostCommand, PickDirectoryOptions } from './host-platform-contract.ts';

import { existsSync } from 'node:fs';

import { hostPlatformModule } from './host-platform.ts';

export type { PickDirectoryOptions } from './host-platform-contract.ts';

/** Per-platform picker invocation. Pure so argv/env wiring remains unit-testable. */
export function directoryPickerSpecs(platform: NodeJS.Platform, options: PickDirectoryOptions = {}): HostCommand[] {
  return [...hostPlatformModule.forPlatform(platform).directoryPickerSpecs(options)];
}

const DIALOG_TIMEOUT_MS = 5 * 60_000;

async function runPicker(spec: HostCommand): Promise<string | null> {
  const proc = Bun.spawn(spec.argv, {
    stdout: 'pipe',
    stderr: 'ignore',
    env: spec.env ? { ...process.env, ...spec.env } : process.env
  });
  const timer = setTimeout(() => proc.kill(), DIALOG_TIMEOUT_MS);
  try {
    const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exit !== 0) return null;
    const path = out.trim();
    if (!path) return null;
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
  } finally {
    clearTimeout(timer);
  }
}

let inFlight: Promise<string | null> | null = null;

export function pickDirectory(options: PickDirectoryOptions = {}): Promise<string | null> {
  if (inFlight) return Promise.resolve(null);
  const defaultPath = options.defaultPath && existsSync(options.defaultPath) ? options.defaultPath : undefined;
  const run = (async () => {
    for (const spec of hostPlatformModule.current.directoryPickerSpecs({ ...options, defaultPath })) {
      try {
        return await runPicker(spec);
      } catch {
        // Missing picker binary: continue to the next platform fallback.
      }
    }
    return null;
  })();
  inFlight = run;
  return run.finally(() => {
    inFlight = null;
  });
}
