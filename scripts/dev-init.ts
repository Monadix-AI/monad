#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * One-time idempotent dev environment initialization.
 *
 * Runs automatically as the `postinstall` hook in the root package.json, so a fresh
 * worktree is fully initialized by `bun install` alone — no separate `bun dev` step.
 * Skips itself in CI / production / Docker-image builds (see the guard in main()), where
 * the heavy dev-only work (Phoenix, Mo.app, schema/license gen) is neither wanted nor safe.
 * Safe to run repeatedly; will not overwrite an existing .env.local unless
 * MONAD_HOME points outside the project directory (auto-migrated in-place).
 *
 * What it does:
 *   1. Creates .env.local from .env.example if it doesn't exist,
 *      substituting MONAD_HOME=<project>/.dev/.monad.
 *   2. Migrates an existing .env.local whose MONAD_HOME is outside the
 *      project root, preserving all other lines.
 *   3. Creates the MONAD_HOME directory if it doesn't exist.
 *   4. Scaffolds packages/home/config.init.json from config.init.json.template (dev seed) if missing,
 *      and warns if its apiKey is empty.
 *   5. Initializes CodeGraph when the local machine has it installed and this checkout is unindexed.
 *   6. Prints a connection summary (daemon URL, data dir).
 *   7. Regenerates checked-in/generated dev artifacts used by typecheck and local builds.
 *
 * The initialization body runs only when executed directly (import.meta.main); the pure
 * port helpers below are exported so dev-init.test.ts can unit-test them without
 * triggering any filesystem side effects.
 */

import { chmod, mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

// ── Per-worktree dev port assignment ─────────────────────────────────────────
// The daemon binds a TCP port unconditionally (the WS push channel is TCP-only), so two worktrees
// running `bun dev` at once would both grab the default 52749/3000/6480/4983 and the second fails
// with EADDRINUSE. A stable offset derived from the worktree path gives each checkout its own ports;
// both daemon and clients read MONAD_PORT, so they stay in sync.

/** Stable 0–999 offset from a seed string (FNV-1a/32). Same path → same ports, always. */
export function portOffset(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 1000;
}

export interface WorktreePorts {
  MONAD_PORT: string; // 52000–52999
  WEB_PORT: string; // 3100–4099
  MONAD_KV_UI_PORT: string; // 6400–7399 (dev KV debug UI)
  AI_SDK_DEVTOOLS_PORT: string; // 7400–8399 (AI SDK DevTools)
}

export function worktreePorts(root: string): WorktreePorts {
  const offset = portOffset(root);
  return {
    MONAD_PORT: String(52000 + offset),
    WEB_PORT: String(3100 + offset),
    MONAD_KV_UI_PORT: String(6400 + offset),
    AI_SDK_DEVTOOLS_PORT: String(7400 + offset)
  };
}

export interface DevInitSummaryOptions {
  apiKeySet: boolean;
  monadHome: string;
  otelUiUrl?: string;
  ports: WorktreePorts;
}

interface OutputStyleOptions {
  color?: boolean;
}

interface DevStepStatusOptions extends OutputStyleOptions {
  label: string;
  state: 'running' | 'done';
  target: string;
  tty: boolean;
  verb?: string;
}

interface DevStepProgressOptions extends OutputStyleOptions {
  frame: string;
  label: string;
  target: string;
  verb?: string;
}

interface GeneratedArtifactStatusOptions extends OutputStyleOptions {
  label: string;
  state: 'running' | 'done';
  target: string;
  tty: boolean;
}

interface GeneratedArtifactProgressOptions extends OutputStyleOptions {
  frame: string;
  label: string;
  target: string;
}

function portUrl(port: string): string {
  return `http://127.0.0.1:${port}`;
}

const ansi = {
  blue: '\u001b[34m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  reset: '\u001b[0m',
  yellow: '\u001b[33m'
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

function warning(value: string, enabled: boolean): string {
  return colorize(value, 'yellow', enabled);
}

function muted(value: string, enabled: boolean): string {
  return colorize(value, 'dim', enabled);
}

function shouldColorOutput(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

export function buildDevInitSummary(
  { apiKeySet, monadHome, otelUiUrl, ports }: DevInitSummaryOptions,
  options: OutputStyleOptions = {}
): string[] {
  const useColor = options.color ?? false;
  return [
    '',
    strong('Monad dev init', useColor),
    label('Environment', useColor),
    `  ${muted('Data directory', useColor)}    ${monadHome}`,
    `  ${muted('API key', useColor)}           ${
      apiKeySet ? success('set', useColor) : warning('not set - add apiKey to packages/home/config.init.json', useColor)
    }`,
    label('Ports', useColor),
    `  ${muted('Daemon API', useColor)}        ${portUrl(ports.MONAD_PORT)}`,
    `  ${muted('Web app', useColor)}           ${portUrl(ports.WEB_PORT)}`,
    `  ${muted('KV inspector', useColor)}      ${portUrl(ports.MONAD_KV_UI_PORT)}`,
    `  ${muted('AI SDK DevTools', useColor)}   ${portUrl(ports.AI_SDK_DEVTOOLS_PORT)}`,
    label('Services', useColor),
    `  ${muted('Phoenix / OTel', useColor)}    ${
      otelUiUrl || warning('not running - install Docker or start Phoenix manually', useColor)
    }`,
    ''
  ];
}

export function buildDevStepStatusFrame({
  color,
  label: stepLabel,
  state,
  target,
  tty,
  verb = 'done'
}: DevStepStatusOptions) {
  const useColor = color ?? false;
  void tty;
  if (state === 'running') return '';
  const status = success(verb, useColor);
  const line = `[dev-init] ${status} ${stepLabel} -> ${muted(target, useColor)}`;
  return `${line}\n`;
}

export function buildDevStepProgressFrame({
  color,
  frame,
  label: stepLabel,
  target,
  verb = 'running'
}: DevStepProgressOptions) {
  const useColor = color ?? false;
  return `\r[dev-init] ${colorize(frame, 'blue', useColor)} ${verb} ${stepLabel} -> ${muted(target, useColor)}`;
}

export function buildGeneratedArtifactStatusFrame(options: GeneratedArtifactStatusOptions) {
  return buildDevStepStatusFrame({ ...options, verb: 'generated' });
}

export function buildGeneratedArtifactProgressFrame(options: GeneratedArtifactProgressOptions) {
  return buildDevStepProgressFrame({ ...options, verb: 'generating' });
}

function generatedArtifactsHeader(color: boolean): string {
  return [
    '',
    strong('Generated artifacts', color),
    muted('Tool output is shown inline below each generator.', color),
    ''
  ].join('\n');
}

async function runDevInitCommandStep(options: {
  color: boolean;
  command: string[];
  cwd?: string;
  doneVerb: string;
  label: string;
  target: string;
  verb: string;
}): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const tty = Boolean(process.stdout.isTTY);
  const spinnerFrames = ['-', '\\', '|', '/'];
  let spinnerIndex = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  if (tty) {
    process.stdout.write(
      buildDevStepProgressFrame({
        color: options.color,
        frame: spinnerFrames[spinnerIndex] ?? '-',
        label: options.label,
        target: options.target,
        verb: options.verb
      })
    );
    spinnerTimer = setInterval(() => {
      spinnerIndex += 1;
      process.stdout.write(
        buildDevStepProgressFrame({
          color: options.color,
          frame: spinnerFrames[spinnerIndex % spinnerFrames.length] ?? '-',
          label: options.label,
          target: options.target,
          verb: options.verb
        })
      );
    }, 120);
  }
  const proc = Bun.spawn(options.command, {
    cwd: options.cwd,
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
      buildDevStepStatusFrame({
        color: options.color,
        label: options.label,
        state: 'done',
        target: options.target,
        tty,
        verb: options.doneVerb
      })
    );
  }
  return { exitCode, stderr, stdout };
}

/**
 * Append `KEY=value` lines for any port not already present in `envText` (a missing/blank key is
 * treated as absent, so a hand-set value is never clobbered). Returns the new text plus the list
 * of `KEY=value` strings that were added. Idempotent: a second call with the result adds nothing.
 */
export function ensurePortLines(envText: string, ports: WorktreePorts): { text: string; added: string[] } {
  const present = new Set<string>();
  for (const raw of envText.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (val) present.add(key);
  }

  let text = envText;
  const added: string[] = [];
  for (const [key, value] of Object.entries(ports)) {
    if (present.has(key)) continue;
    text += `${text.endsWith('\n') || text === '' ? '' : '\n'}${key}=${value}\n`;
    added.push(`${key}=${value}`);
  }
  return { text, added };
}

const xdgEnvKeys = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'];
const blankXdgLinePattern = new RegExp(`^\\s*(${xdgEnvKeys.join('|')})\\s*=\\s*(?:""|''|)\\s*$`);

export function removeBlankXdgLines(envText: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const lines = envText.split('\n');
  const kept = lines.filter((line, index) => {
    if (index === lines.length - 1 && line === '' && envText.endsWith('\n')) return true;
    const match = line.match(blankXdgLinePattern);
    if (!match) return true;
    removed.push(match[1]);
    return false;
  });
  return { text: kept.join('\n'), removed };
}

export function shouldInitCodeGraph(codeGraphAvailable: boolean, indexExists: boolean): boolean {
  return codeGraphAvailable && !indexExists;
}

const managedPostCheckoutHookMarker = 'monad managed post-checkout bootstrap';

export function postCheckoutHookText(): string {
  return [
    '#!/bin/sh',
    `# ${managedPostCheckoutHookMarker}`,
    'set -u',
    '',
    'root=$(git rev-parse --show-toplevel 2>/dev/null || true)',
    '',
    'if [ -n "$root" ] && [ -x "$root/scripts/git-hooks/post-checkout.sh" ]; then',
    '  "$root/scripts/git-hooks/post-checkout.sh" "$@" || exit $?',
    'fi',
    '',
    'if command -v lefthook >/dev/null 2>&1; then',
    '  lefthook run "post-checkout" "$@"',
    'elif [ -n "$root" ] && [ -x "$root/node_modules/.bin/lefthook" ]; then',
    '  "$root/node_modules/.bin/lefthook" run "post-checkout" "$@"',
    'else',
    '  echo "[monad hook] lefthook not found; skipped post-checkout lefthook jobs" >&2',
    'fi'
  ].join('\n');
}

async function installPostCheckoutHook(root: string, log: (msg: string) => void, warn: (msg: string) => void) {
  const commonDirText = await Bun.$`git rev-parse --git-common-dir`
    .cwd(root)
    .quiet()
    .text()
    .then((t) => t.trim())
    .catch(() => '');

  if (!commonDirText) {
    warn('git hooks path not found — skipping post-checkout bootstrap install');
    return;
  }

  const commonDir = isAbsolute(commonDirText) ? commonDirText : join(root, commonDirText);
  const hooksDir = join(commonDir, 'hooks');
  const hookPath = join(hooksDir, 'post-checkout');
  const desired = `${postCheckoutHookText()}\n`;
  const current = (await Bun.file(hookPath).exists()) ? await Bun.file(hookPath).text() : '';

  if (current === desired) {
    log('git hook              post-checkout bootstrap already installed');
    return;
  }

  if (current && !current.includes(managedPostCheckoutHookMarker)) {
    log('git hook              replacing post-checkout with monad bootstrap wrapper');
  }

  await mkdir(hooksDir, { recursive: true });
  await Bun.write(hookPath, desired);
  await chmod(hookPath, 0o755);
  log('git hook              post-checkout bootstrap installed');
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

/**
 * True when this install is not an interactive local-dev one: CI (`CI` is set by GitHub Actions and
 * most CI providers), an explicit opt-out, or a production install. In those contexts `postinstall`
 * must be a no-op — the dev bootstrap below pokes Docker, builds native sprites, and scaffolds a seed
 * config holding secrets, none of which belong in CI or a release/image build.
 */
function shouldSkipDevInit(): boolean {
  return Boolean(process.env.CI || process.env.MONAD_SKIP_SETUP || process.env.NODE_ENV === 'production');
}

async function main(): Promise<void> {
  if (shouldSkipDevInit()) {
    process.stdout.write('[dev-init] skipped (CI/production/opt-out)\n');
    return;
  }

  const root = resolve(import.meta.dir, '..');
  const envLocalPath = join(root, '.env.local');
  const envExamplePath = join(root, '.env.example');

  const defaultMonadHome = join(root, '.dev', '.monad');

  // Per-worktree ports (stable, derived from the checkout path) so multiple worktrees can run
  // `bun dev` at once without clashing.
  const ports = worktreePorts(root);
  const color = shouldColorOutput();

  const log = (msg: string): void => {
    process.stdout.write(`[dev-init] ${msg}\n`);
  };

  const warn = (msg: string): void => {
    process.stderr.write(`[dev-init] WARNING: ${msg}\n`);
  };

  await installPostCheckoutHook(root, log, warn);

  // ── 1. Create or migrate .env.local ──────────────────────────────────────────

  const envLocalExists = await Bun.file(envLocalPath).exists();

  if (!envLocalExists) {
    const envExampleFile = Bun.file(envExamplePath);
    if (!(await envExampleFile.exists())) {
      warn('.env.example not found — skipping .env.local creation');
      process.exit(0);
    }

    const exampleText = await envExampleFile.text();

    const localText = exampleText.replace(/^MONAD_HOME=\s*$/m, `MONAD_HOME=${defaultMonadHome}`);

    await Bun.write(envLocalPath, localText);
    log(`.env.local created  (MONAD_HOME=${defaultMonadHome})`);
  } else {
    // Migrate: if MONAD_HOME is outside the project root, update it in-place,
    // preserving the API key and all other lines the developer may have edited.
    const existingText = await Bun.file(envLocalPath).text();
    const existingHome = parseEnvFile(existingText).get('MONAD_HOME') ?? '';

    if (existingHome && !existingHome.startsWith(root)) {
      const migratedText = existingText.replace(/^MONAD_HOME=.*$/m, `MONAD_HOME=${defaultMonadHome}`);
      await Bun.write(envLocalPath, migratedText);
      log(`.env.local migrated  ${existingHome} → ${defaultMonadHome}`);
    } else {
      log('.env.local already exists — skipping creation');
    }
  }

  // ── 2. Resolve MONAD_HOME and ensure directory exists ────────────────────────

  let currentEnvText = await Bun.file(envLocalPath).text();
  const { text: cleanedEnvText, removed: removedXdgKeys } = removeBlankXdgLines(currentEnvText);
  if (removedXdgKeys.length > 0) {
    currentEnvText = cleanedEnvText;
    await Bun.write(envLocalPath, currentEnvText);
    log(`blank XDG vars removed ${removedXdgKeys.join('  ')}`);
  }

  // Ensure per-worktree ports exist (append if absent — never clobber a hand-set value).
  const { text: envText, added } = ensurePortLines(currentEnvText, ports);
  if (added.length > 0) {
    await Bun.write(envLocalPath, envText);
    log(`ports assigned        ${added.join('  ')}`);
  }
  const envVars = parseEnvFile(envText);

  const monadHome = envVars.get('MONAD_HOME') || Bun.env.MONAD_HOME || defaultMonadHome;

  await mkdir(monadHome, { recursive: true });
  log(`MONAD_HOME ready       ${monadHome}`);

  // ── 3. Scaffold config.init.json (dev seed) and warn on missing API key ───────

  const seedPath = join(root, 'packages', 'home', 'config.init.json');
  const seedTemplatePath = join(root, 'packages', 'home', 'config.init.json.template');

  /**
   * Find the main worktree's config.init.json by checking git worktrees.
   * Returns the path to the main worktree's seed file, or null if not found.
   */
  async function findMainSeedPath(): Promise<string | null> {
    try {
      const worktreesOutput = await Bun.$`git worktree list --porcelain`
        .quiet()
        .text()
        .then((t) => t.trim())
        .catch(() => '');

      if (!worktreesOutput) return null;

      // porcelain format: blank-line-separated stanzas; each stanza has:
      //   worktree <path>
      //   HEAD <sha>
      //   branch refs/heads/<name>   (or "detached")
      let currentPath = '';
      for (const line of worktreesOutput.split('\n')) {
        if (line.startsWith('worktree ')) {
          currentPath = line.slice('worktree '.length).trim();
        } else if (line.startsWith('branch ')) {
          const branch = line.slice('branch '.length).trim();
          if (branch === 'refs/heads/main' && currentPath && currentPath !== root) {
            const mainSeed = join(currentPath, 'packages', 'home', 'config.init.json');
            if (await Bun.file(mainSeed).exists()) {
              return mainSeed;
            }
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  if (!(await Bun.file(seedPath).exists())) {
    // Try to copy from main worktree first
    const mainSeed = await findMainSeedPath();
    if (mainSeed) {
      try {
        await Bun.write(seedPath, await Bun.file(mainSeed).text());
        log('config.init.json copied from main worktree');
      } catch {
        // Fall through to template
      }
    }

    // Fall back to template if not copied from main
    if (!(await Bun.file(seedPath).exists())) {
      if (await Bun.file(seedTemplatePath).exists()) {
        await Bun.write(seedPath, await Bun.file(seedTemplatePath).text());
        log('config.init.json created from template');
      } else {
        warn('config.init.json.template not found — skipping dev seed scaffold');
      }
    }
  }

  let seedApiKey = '';
  try {
    const seed = (await Bun.file(seedPath).json()) as { apiKey?: string };
    seedApiKey = (seed.apiKey ?? '').trim();
  } catch {
    /* missing or malformed — covered by the warning below */
  }

  const apiKey = seedApiKey;
  if (!apiKey) {
    warn('No API key in config.init.json (apiKey field)');
    warn('  Get a key at https://openrouter.ai/keys and set it in config.init.json');
    warn('  The daemon will start but AI calls will fail until the key is set.');
  }

  const codeGraphBin = Bun.which('codegraph');
  const codeGraphAvailable = codeGraphBin !== null;
  const codeGraphIndexExists = await Bun.file(join(root, '.codegraph', 'codegraph.db')).exists();
  if (codeGraphBin && shouldInitCodeGraph(codeGraphAvailable, codeGraphIndexExists)) {
    const result = await runDevInitCommandStep({
      color,
      command: [codeGraphBin, 'init', '-i'],
      cwd: root,
      doneVerb: 'ready',
      label: 'CodeGraph',
      target: '.codegraph/codegraph.db',
      verb: 'indexing'
    });
    if (result.exitCode !== 0) {
      warn(`CodeGraph             init failed with exit code ${result.exitCode}`);
    }
  } else if (codeGraphAvailable) {
    log('CodeGraph             already indexed');
  }

  // ── 4. Arize Phoenix (local LLM observability backend) ───────────────────────
  // Single container, LLM-aware UI. Accepts OTLP HTTP/protobuf on 6006 (same port as the UI) —
  // that's what the daemon exports to; 4317/4318 are also exposed for other OTLP clients.
  // Idempotent: a running container is left untouched; stopped → restart.

  let otelUiUrl = '';
  try {
    const dockerAvailable = await Bun.$`docker info`
      .quiet()
      .then(() => true)
      .catch(() => false);
    if (!dockerAvailable) {
      log('Phoenix               skipped  (docker not found)');
    } else {
      const running = await Bun.$`docker inspect -f '{{.State.Running}}' phoenix`
        .quiet()
        .text()
        .then((t) => t.trim() === 'true')
        .catch(() => false);
      if (running) {
        log('Phoenix               already running');
        otelUiUrl = 'http://localhost:6006';
      } else {
        const exists = await Bun.$`docker inspect phoenix`
          .quiet()
          .then(() => true)
          .catch(() => false);
        if (exists) {
          const result = await runDevInitCommandStep({
            color,
            command: ['docker', 'start', 'phoenix'],
            doneVerb: 'restarted',
            label: 'Phoenix',
            target: 'http://localhost:6006',
            verb: 'starting'
          });
          if (result.exitCode !== 0) warn(`Phoenix               restart failed with exit code ${result.exitCode}`);
        } else {
          const imagePresent = await Bun.$`docker image inspect arizephoenix/phoenix`
            .quiet()
            .then(() => true)
            .catch(() => false);
          if (!imagePresent) {
            const pull = await runDevInitCommandStep({
              color,
              command: ['docker', 'pull', 'arizephoenix/phoenix'],
              doneVerb: 'pulled',
              label: 'Phoenix image',
              target: 'arizephoenix/phoenix',
              verb: 'pulling'
            });
            if (pull.exitCode !== 0) warn(`Phoenix               image pull failed with exit code ${pull.exitCode}`);
          }
          const run = await runDevInitCommandStep({
            color,
            command: [
              'docker',
              'run',
              '-d',
              '-p',
              '6006:6006',
              '-p',
              '4318:4318',
              '--name',
              'phoenix',
              'arizephoenix/phoenix'
            ],
            doneVerb: 'started',
            label: 'Phoenix',
            target: 'http://localhost:6006',
            verb: 'starting'
          });
          if (run.exitCode !== 0) warn(`Phoenix               start failed with exit code ${run.exitCode}`);
        }
        otelUiUrl = 'http://localhost:6006';
      }
    }
  } catch (err) {
    warn(`Phoenix               failed to start: ${err instanceof Error ? err.message : String(err)}`);
    warn('  Start it manually: docker run -d -p 6006:6006 -p 4318:4318 --name phoenix arizephoenix/phoenix');
  }

  // ── 4b. Mo desktop sprite (macOS) ────────────────────────────────────────────
  // Regenerate the native atlas header from the manifest, then build the
  // native Mo.app once so `bun dev` can Launch it — MoService probes the repo build in dev. macOS-only
  // for now; non-fatal (skipped without clang/Xcode CLT), and only built when missing so repeat
  // `bun dev` runs stay fast.
  await runDevInitCommandStep({
    color,
    command: ['bun', 'run', join(root, 'scripts/gen-mo-atlas.ts')],
    doneVerb: 'generated',
    label: 'Mo atlas',
    target: 'apps/mo/native/common/atlas.h',
    verb: 'generating'
  });
  if (process.platform === 'darwin') {
    const moBin = join(root, 'apps/mo/native/macos/Mo.app/Contents/MacOS/mo');
    // Rebuild when the binary is missing OR any native source is newer than it — otherwise a behavior
    // change (mo.m / common/*) would silently run the stale Mo.app on the next `bun dev`.
    const sources = [
      'apps/mo/native/macos/mo.m',
      'apps/mo/native/macos/build.sh',
      'apps/mo/native/common/behavior.c',
      'apps/mo/native/common/behavior.h',
      'apps/mo/native/common/daemon.c',
      'apps/mo/native/common/daemon.h',
      'apps/mo/assets/atlas.json',
      'scripts/gen-mo-atlas.ts'
    ].map((p) => join(root, p));
    const binMtime = (await Bun.file(moBin).exists()) ? Bun.file(moBin).lastModified : 0;
    const newestSrc = Math.max(...sources.map((p) => Bun.file(p).lastModified));
    if (binMtime > 0 && binMtime >= newestSrc) {
      log('Mo sprite             up to date');
    } else {
      const hasClang = await Bun.$`command -v clang`
        .quiet()
        .then(() => true)
        .catch(() => false);
      if (!hasClang) {
        log('Mo sprite             skipped  (clang not found — run: xcode-select --install)');
      } else {
        const r = await runDevInitCommandStep({
          color,
          command: ['bash', join(root, 'apps/mo/native/macos/build.sh')],
          doneVerb: 'built',
          label: 'Mo sprite',
          target: 'apps/mo/native/macos/Mo.app',
          verb: 'building'
        });
        if (r.exitCode !== 0) warn('Mo sprite             build failed (see apps/mo)');
      }
    }
  }

  // ── 5. Initialization summary ─────────────────────────────────────────────────

  const resolvedPorts: WorktreePorts = {
    AI_SDK_DEVTOOLS_PORT:
      envVars.get('AI_SDK_DEVTOOLS_PORT') || Bun.env.AI_SDK_DEVTOOLS_PORT || ports.AI_SDK_DEVTOOLS_PORT,
    MONAD_KV_UI_PORT: envVars.get('MONAD_KV_UI_PORT') || Bun.env.MONAD_KV_UI_PORT || ports.MONAD_KV_UI_PORT,
    MONAD_PORT: envVars.get('MONAD_PORT') || Bun.env.MONAD_PORT || '52749',
    WEB_PORT: envVars.get('WEB_PORT') || Bun.env.WEB_PORT || '3000'
  };

  process.stdout.write(
    buildDevInitSummary(
      {
        apiKeySet: Boolean(apiKey),
        monadHome,
        otelUiUrl,
        ports: resolvedPorts
      },
      { color }
    ).join('\n')
  );

  // ── 6. Generated dev artifacts ────────────────────────────────────────────────
  // `monad` is linked into node_modules/.bin by `bun install` (via apps/cli bin field).
  // Run the CLI with `bun monad <cmd>`, which resolves the workspace bin automatically.

  process.stdout.write(generatedArtifactsHeader(color));

  const generateArtifact = async (artifact: { command: string[]; label: string; target: string }): Promise<void> => {
    await runDevInitCommandStep({
      color,
      command: artifact.command,
      doneVerb: 'generated',
      label: artifact.label,
      target: artifact.target,
      verb: 'generating'
    });
  };

  await generateArtifact({
    command: ['bun', 'run', join(root, 'scripts/generate-codex-app-server-protocol.ts')],
    label: 'Codex app-server protocol',
    target: 'packages/atoms/generated/codex-app-server'
  });

  await generateArtifact({
    command: ['bun', 'run', join(root, 'scripts/generate-avatar-styles.ts')],
    label: 'Avatar styles',
    target: 'packages/protocol/generated/avatar-styles.ts'
  });

  await generateArtifact({
    command: ['bun', 'run', join(root, 'packages/home/scripts/gen-config-schema.ts')],
    label: 'Config schema',
    target: 'packages/home/config.schema.json'
  });

  await generateArtifact({
    command: ['bun', 'run', join(root, 'scripts/generate-licenses.ts')],
    label: 'License inventory',
    target: 'apps/monad/generated/licenses.json'
  });
}

if (import.meta.main) {
  await main();
}
