#!/usr/bin/env bun

/// <reference types="bun" />
/**
 * Dev launcher — bridges per-worktree `.env.local` into the env that turbo's
 * `start:dev`/`devtools` tasks actually read, then spawns turbo.
 *
 * Why this exists:
 *   `predev` (scripts/dev-setup.ts) writes stable per-worktree ports into
 *   `.env.local` (MONAD_PORT / WEB_PORT / MONAD_KV_UI_PORT / AI_SDK_DEVTOOLS_PORT) so two worktrees
 *   can run `bun dev` at once. The daemon picks MONAD_PORT up via its own
 *   `--env-file=../../.env.local`, but Next.js only honours `PORT`/`-p` — it does
 *   NOT read `WEB_PORT`. The old root script relied on a shell-level `$WEB_PORT`,
 *   which is only ever populated by direnv in the MAIN checkout, so every worktree
 *   silently fell back to PORT=3000 and collided. We read `.env.local` here and
 *   mirror WEB_PORT → PORT so the web port rotates per worktree without direnv.
 *
 * Also points Bun's runtime transpiler cache at a single shared directory so the
 * `*.pile` files stop accumulating inside every worktree's node_modules/.cache/bun
 * (keyed by abs-path + content-hash + bun version, so sharing is collision-free).
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

function parseEnvFile(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    map.set(key, val);
  }
  return map;
}

export function buildDevEnv(
  parsed: Map<string, string> | Record<string, string>,
  base: Record<string, string | undefined>,
  homeDir = homedir()
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }

  const entries = parsed instanceof Map ? parsed : new Map(Object.entries(parsed));
  for (const [key, value] of entries) {
    if (!env[key]) env[key] = value;
  }

  if (!base.PORT && env.WEB_PORT) env.PORT = env.WEB_PORT;

  if (!base.BUN_RUNTIME_TRANSPILER_CACHE_PATH) {
    env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = join(homeDir, '.cache', 'monad-bun');
  }

  return env;
}

export function devCommand(): string[] {
  return [
    'bun',
    'turbo',
    'run',
    'start:dev',
    'devtools',
    '--filter=@monad/i18n',
    '--filter=@monad/monad',
    '--filter=@monad/web'
  ];
}

export function i18nCommand(): string[] {
  return ['bun', 'run', 'scripts/i18n.ts', '--write-if-stale'];
}

export function devSpawnOptions(cwd: string, env: Record<string, string>) {
  return {
    cwd,
    env,
    stdin: 'inherit' as const,
    stdout: 'inherit' as const,
    stderr: 'inherit' as const,
    detached: true
  };
}

type DevSignal = NodeJS.Signals | 'SIGKILL';
type DevProcess = { readonly pid: number; kill(signal: DevSignal): void };

interface CleanupDeps {
  platform?: NodeJS.Platform;
  killGroup?(pid: number, signal: DevSignal): void;
  taskkill?(pid: number): void;
}

export function cleanupDevProcess(proc: DevProcess, signal: DevSignal = 'SIGTERM', deps: CleanupDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const killGroup = deps.killGroup ?? ((pid, sig) => process.kill(pid, sig));
  const taskkill =
    deps.taskkill ??
    ((pid) => {
      Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(pid)], { stderr: 'ignore', stdout: 'ignore' });
    });

  try {
    if (platform === 'win32') {
      taskkill(proc.pid);
    } else {
      killGroup(-proc.pid, signal);
    }
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function killPortSurvivors(env: Record<string, string>): void {
  if (process.platform === 'win32') return;
  const ports = [env.WEB_PORT, env.MONAD_PORT].filter(Boolean);
  for (const port of ports) {
    const result = Bun.spawnSync(['lsof', '-ti', `:${port}`], { stdout: 'pipe', stderr: 'pipe' });
    const pids = result.stdout.toString().trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

export async function main(): Promise<number> {
  const envLocal = Bun.file(join(root, '.env.local'));
  const parsed = (await envLocal.exists()) ? parseEnvFile(await envLocal.text()) : new Map<string, string>();
  const env = buildDevEnv(parsed, process.env as Record<string, string | undefined>);

  const i18n = Bun.spawn(i18nCommand(), {
    cwd: root,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  });
  const i18nExitCode = await i18n.exited;
  if (i18nExitCode !== 0) return i18nExitCode;

  const proc = Bun.spawn(devCommand(), devSpawnOptions(root, env));

  const cleanup = (sig: DevSignal = 'SIGTERM'): void => cleanupDevProcess(proc, sig);
  process.on('exit', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));

  const exitCode = await proc.exited;
  killPortSurvivors(env);
  cleanup('SIGTERM');
  return exitCode;
}

if (import.meta.main) {
  process.exit(await main());
}
