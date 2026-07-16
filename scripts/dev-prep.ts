#!/usr/bin/env bun
/**
 * Dev prep — prints the resolved local-dev environment, refreshes generated
 * artifacts, then starts the daemon/web/devtools task group.
 *
 * Why this exists:
 *   `postinstall` (scripts/dev-init.ts) writes stable per-worktree ports into
 *   `.env.local` (MONAD_PORT / WEB_PORT / MONAD_KV_UI_PORT / AI_SDK_DEVTOOLS_PORT) so two worktrees
 *   can run `bun dev` at once. The daemon picks MONAD_PORT up via its own
 *   `--env-file=../../.env.local`, while the Vite task reads `WEB_PORT` from its
 *   process environment. The old root script relied on direnv populating that value
 *   in the main checkout, so linked worktrees silently fell back to port 3000. This
 *   launcher reads `.env.local` before starting Turbo so every worktree gets its port.
 *
 * Also points Bun's runtime transpiler cache at a single shared directory so the
 * `*.pile` files stop accumulating inside every worktree's node_modules/.cache/bun
 * (keyed by abs-path + content-hash + bun version, so sharing is collision-free).
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { worktreePorts } from './dev-init/ports.ts';

const root = resolve(import.meta.dir, '..');
const unset = 'not set';

interface OutputStyleOptions {
  color?: boolean;
}

interface DevPrepStepProgressOptions extends OutputStyleOptions {
  frame: string;
  label: string;
  target: string;
  verb: string;
}

interface DevPrepStepStatusOptions extends OutputStyleOptions {
  label: string;
  target: string;
  verb: string;
}

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
  homeDir = homedir(),
  worktreeRoot?: string
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

  if (worktreeRoot) {
    const ports = worktreePorts(worktreeRoot);
    if (!env.WEB_STORYBOOK_PORT) env.WEB_STORYBOOK_PORT = ports.WEB_STORYBOOK_PORT;
    if (!env.UI_STORYBOOK_PORT) env.UI_STORYBOOK_PORT = ports.UI_STORYBOOK_PORT;
  }

  if (!base.BUN_RUNTIME_TRANSPILER_CACHE_PATH) {
    env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = join(homeDir, '.cache', 'monad-bun');
  }

  return env;
}

export function devCommand(): string[] {
  return [
    'bunx',
    'turbo',
    'run',
    '@monad/i18n#start:dev',
    '@monad/monad#start:dev',
    '@monad/monad#devtools',
    '@monad/web#start:dev',
    '@monad/ui#storybook',
    '@monad/web#storybook'
  ];
}

function portUrl(port: string | undefined, scheme: 'http' | 'https' = 'http'): string {
  return port ? `${scheme}://127.0.0.1:${port}` : unset;
}

function valueOrUnset(value: string | undefined): string {
  return value?.trim() ? value : unset;
}

const ansi = {
  blue: '\u001b[34m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  reset: '\u001b[0m'
} as const;

function colorize(value: string, color: keyof typeof ansi, enabled: boolean): string {
  return enabled ? `${ansi[color]}${value}${ansi.reset}` : value;
}

function strong(value: string, enabled: boolean): string {
  return enabled ? `${ansi.bold}${value}${ansi.reset}` : value;
}

function label(value: string, enabled: boolean): string {
  return colorize(value, 'cyan', enabled);
}

function success(value: string, enabled: boolean): string {
  return colorize(value, 'green', enabled);
}

function muted(value: string, enabled: boolean): string {
  return colorize(value, 'dim', enabled);
}

function shouldColorOutput(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

export function buildDevPrepSummary(
  env: Record<string, string | undefined>,
  options: OutputStyleOptions = {}
): string[] {
  const useColor = options.color ?? false;
  return [
    '',
    strong('Monad dev prep', useColor),
    label('Ports', useColor),
    `  ${muted('Daemon API', useColor)}        ${portUrl(env.MONAD_PORT, 'https')}`,
    `  ${muted('Local HTTP', useColor)}        ${portUrl(env.MONAD_HTTP_PORT)}`,
    `  ${muted('Web app', useColor)}           ${portUrl(env.PORT ?? env.WEB_PORT)}`,
    `  ${muted('Web Storybook', useColor)}     ${portUrl(env.WEB_STORYBOOK_PORT)}`,
    `  ${muted('UI Storybook', useColor)}      ${portUrl(env.UI_STORYBOOK_PORT)}`,
    `  ${muted('KV inspector', useColor)}      ${portUrl(env.MONAD_KV_UI_PORT)}`,
    label('Runtime URL priority', useColor),
    `  ${muted('Daemon proxy', useColor)}      MONAD_URL > config network.host/https/port`,
    label('Runtime', useColor),
    `  ${muted('Bun transpiler', useColor)}    ${valueOrUnset(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH)}`,
    label('Tasks', useColor),
    '  1. Refresh i18n artifacts',
    '  2. Start daemon, web app, Storybook, and devtools',
    ''
  ];
}

export function buildDevPrepStepProgressFrame({
  color,
  frame,
  label: stepLabel,
  target,
  verb
}: DevPrepStepProgressOptions) {
  const useColor = color ?? false;
  return `\r[dev-prep] ${colorize(frame, 'blue', useColor)} ${verb} ${stepLabel} -> ${muted(target, useColor)}`;
}

export function buildDevPrepStepStatusFrame({ color, label: stepLabel, target, verb }: DevPrepStepStatusOptions) {
  const useColor = color ?? false;
  return `[dev-prep] ${success(verb, useColor)} ${stepLabel} -> ${muted(target, useColor)}\n`;
}

function printDevPrepSummary(env: Record<string, string | undefined>, color: boolean): void {
  process.stdout.write(buildDevPrepSummary(env, { color }).join('\n'));
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

type PortPidLookup = (port: string) => string[];
type PortLookupSpawn = (command: string[]) => { stdout: Buffer; stderr: Buffer };

export function lookupPortPids(
  port: string,
  spawn: PortLookupSpawn = (command) => Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' })
): string[] {
  const result = spawn(['lsof', `-tiTCP:${port}`, '-sTCP:LISTEN']);
  return result.stdout.toString().trim().split('\n').filter(Boolean);
}

export function reportPortSurvivors(
  env: Record<string, string>,
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
  lookup: PortPidLookup = lookupPortPids,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === 'win32') return;
  const ports = [env.WEB_PORT, env.MONAD_PORT, env.MONAD_HTTP_PORT, env.WEB_STORYBOOK_PORT, env.UI_STORYBOOK_PORT]
    .filter((port): port is string => Boolean(port))
    .sort();
  for (const port of ports) {
    const pids = lookup(port);
    if (pids.length === 0) continue;
    warn(
      `[dev-prep] port ${port} is still occupied by PID ${pids.join(', ')}; inspect it with: lsof -nP -iTCP:${port} -sTCP:LISTEN`
    );
  }
}

async function runDevPrepCommandStep(options: {
  color: boolean;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  label: string;
  target: string;
}): Promise<number> {
  const tty = Boolean(process.stdout.isTTY);
  const spinnerFrames = ['-', '\\', '|', '/'];
  let spinnerIndex = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  if (tty) {
    process.stdout.write(
      buildDevPrepStepProgressFrame({
        color: options.color,
        frame: spinnerFrames[spinnerIndex] ?? '-',
        label: options.label,
        target: options.target,
        verb: 'refreshing'
      })
    );
    spinnerTimer = setInterval(() => {
      spinnerIndex += 1;
      process.stdout.write(
        buildDevPrepStepProgressFrame({
          color: options.color,
          frame: spinnerFrames[spinnerIndex % spinnerFrames.length] ?? '-',
          label: options.label,
          target: options.target,
          verb: 'refreshing'
        })
      );
    }, 120);
  }
  const proc = Bun.spawn(options.command, {
    cwd: options.cwd,
    env: options.env,
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (spinnerTimer) clearInterval(spinnerTimer);
  if (tty) process.stdout.write('\r\u001b[2K');
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (exitCode === 0) {
    process.stdout.write(
      buildDevPrepStepStatusFrame({
        color: options.color,
        label: options.label,
        target: options.target,
        verb: 'refreshed'
      })
    );
  }
  return exitCode;
}

export async function main(): Promise<number> {
  const envLocal = Bun.file(join(root, '.env.local'));
  const parsed = (await envLocal.exists()) ? parseEnvFile(await envLocal.text()) : new Map<string, string>();
  const env = buildDevEnv(parsed, process.env as Record<string, string | undefined>, homedir(), root);
  const color = shouldColorOutput();
  printDevPrepSummary(env, color);

  const i18nExitCode = await runDevPrepCommandStep({
    color,
    command: i18nCommand(),
    cwd: root,
    env,
    label: 'i18n artifacts',
    target: 'scripts/i18n.ts --write-if-stale'
  });
  if (i18nExitCode !== 0) return i18nExitCode;

  process.stdout.write('[dev-prep] starting dev task group -> turbo start:dev + devtools + storybook\n');

  const proc = Bun.spawn(devCommand(), devSpawnOptions(root, env));

  const cleanup = (sig: DevSignal = 'SIGTERM'): void => cleanupDevProcess(proc, sig);
  process.on('exit', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));

  const exitCode = await proc.exited;
  cleanup('SIGTERM');
  reportPortSurvivors(env);
  return exitCode;
}

if (import.meta.main) {
  process.exit(await main());
}
