// Docker/Podman sandbox launcher — runs commands in a disposable container. Implements spawn()
// (not wrap()) so it can access cwd/env from SandboxSpawnOptions and mount the right paths.
//
// Isolation model: a fresh --rm container per run, with explicit rw/ro volume mounts for the
// policy's writable/readable roots (at the same host paths so argv paths work unchanged), --read-only
// for everything else, network isolation when net:'none', and resource caps. readDenyRoots are
// simply not mounted, so they don't exist inside the container.
//
// Detection: probed once and cached (detectDockerRuntime) so isAvailable() is synchronous.
// Prefers podman over docker (rootless by default, no daemon required).

import type { SandboxLauncher, SandboxPolicy, SandboxProcess, SandboxSpawnOptions } from '@monad/sdk-atom';

import { realpathSync } from 'node:fs';

export type ContainerRuntime = 'docker' | 'podman';

let _runtime: ContainerRuntime | null | undefined;

/** Probe for an available container runtime. Cached for the process lifetime. */
export async function detectDockerRuntime(): Promise<ContainerRuntime | null> {
  if (_runtime !== undefined) return _runtime;
  for (const cmd of ['podman', 'docker'] as const) {
    try {
      const proc = Bun.spawn([cmd, 'info'], { stdout: 'ignore', stderr: 'ignore' });
      if ((await proc.exited) === 0) {
        _runtime = cmd;
        return _runtime;
      }
    } catch {
      /* try next */
    }
  }
  _runtime = null;
  return null;
}

/** Sync check after detectDockerRuntime() has resolved. */
export function dockerRuntimeAvailable(): boolean {
  return _runtime !== null && _runtime !== undefined;
}

let _image = 'ubuntu:22.04';
/** Override the container image (e.g. from config.agent.sandbox.dockerImage). */
export function configureDockerImage(image: string): void {
  _image = image;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export const dockerLauncher: SandboxLauncher = {
  kind: 'docker',
  platforms: undefined,
  enforces: { writeConfine: true, readDeny: true, net: ['none', 'unrestricted'] },
  isAvailable: () => dockerRuntimeAvailable(),
  spawn(argv: string[], options: SandboxSpawnOptions, policy: SandboxPolicy): SandboxProcess {
    if (!_runtime) throw new Error('docker launcher: no container runtime available (install Docker or Podman)');

    const args: string[] = [_runtime, 'run', '--rm'];

    // Network isolation.
    if (policy.net === 'none') {
      args.push('--network', 'none');
    }

    // Resource caps.
    args.push('--memory', '256m', '--cpus', '0.5', '--pids-limit', '128');
    args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');

    // Filesystem: read-only by default, explicit rw/ro bind mounts at the same host paths.
    args.push('--read-only');
    // Scratch space for tmp writes (interpreters, compilers, package managers).
    args.push('--tmpfs', '/tmp:rw,size=64m,noexec');

    if (policy.writableRoots !== undefined) {
      for (const root of policy.writableRoots) {
        const real = canonical(root);
        args.push('-v', `${real}:${real}:rw`);
      }
    } else {
      // Unrestricted mode: bind the host root rw (no write confinement requested).
      args.push('-v', '/:/host-root:rw', '--read-only=false');
    }

    for (const root of policy.readableRoots ?? []) {
      const real = canonical(root);
      args.push('-v', `${real}:${real}:ro`);
    }
    // readDenyRoots are simply not mounted — they don't exist inside the container.

    const cwd = options.cwd ?? policy.writableRoots?.[0] ?? '/tmp';
    args.push('--workdir', cwd);

    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        if (v !== undefined) args.push('-e', `${k}=${v}`);
      }
    }

    args.push(_image, ...argv);

    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' });
    return {
      pid: proc.pid,
      stdout: proc.stdout as ReadableStream<Uint8Array>,
      stderr: proc.stderr as ReadableStream<Uint8Array>,
      stdin: proc.stdin,
      get exitCode() {
        return proc.exitCode;
      },
      exited: proc.exited,
      kill: (signal) => proc.kill(signal as number | undefined)
    };
  }
};
