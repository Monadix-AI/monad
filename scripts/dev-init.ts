#!/usr/bin/env bun
/**
 * One-time idempotent dev environment initialization.
 *
 * Runs automatically as the `postinstall` hook in the root package.json, so a fresh
 * worktree gets its local environment from `bun install` alone.
 * Skips itself in CI / production / Docker-image builds (see the guard in main()), where
 * the heavy dev-only work (Phoenix, schema/license gen) is neither wanted nor safe.
 * Safe to run repeatedly; will not overwrite an existing .env.local unless
 * MONAD_HOME points outside the project directory (auto-migrated in-place).
 *
 * What it does:
 *   1. Creates .env.local from .env.example if it doesn't exist,
 *      substituting MONAD_HOME=<project>/.dev/.monad.
 *   2. Migrates an existing .env.local whose MONAD_HOME is outside the
 *      project root, preserving all other lines.
 *   3. Creates the MONAD_HOME directory if it doesn't exist.
 *   4. Scaffolds packages/environment/config.init.json from config.init.json.template (dev seed) if missing,
 *      and warns if its apiKey is empty.
 *   5. Copies the main worktree's Turbo remote-cache binding when this worktree is not linked.
 *   6. Installs a worktree-local `monad` CLI shim under .dev/bin.
 *   7. Initializes a worktree-local CodeGraph index when the CLI is available.
 *   8. Regenerates artifacts through the Turbo task graph unless `--skip-generate` is set.
 *   9. Prints a connection summary (daemon URL, data dir).
 *
 * The initialization body runs only when executed directly (import.meta.main).
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { installDevCliShim } from './dev-init/cli-shim';
import { ensureCodeGraph } from './dev-init/codegraph';
import { scaffoldDevSeed } from './dev-init/dev-seed';
import { parseEnvFile, shouldSkipDevInit } from './dev-init/env';
import { buildDevInitSummary, shouldColorOutput } from './dev-init/output';
import { ensurePortLines, removeBlankXdgLines, type WorktreePorts, worktreePorts } from './dev-init/ports';
import { syncTurboRemoteCache } from './dev-init/turbo-cache';

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

  const apiKey = await scaffoldDevSeed(root, log, warn);

  // ── 4. Turbo remote cache ───────────────────────────────────────────────────────

  await syncTurboRemoteCache(root, log, warn);

  // ── 5. Worktree-local CLI ──────────────────────────────────────────────────────

  const cliShimPath = await installDevCliShim(root);
  log(`CLI shim ready        ${cliShimPath}`);

  // ── 6. CodeGraph ──────────────────────────────────────────────────────────────

  const codeGraph = await ensureCodeGraph(root);
  if (codeGraph.status === 'ready') {
    log('CodeGraph ready       .codegraph');
  } else if (codeGraph.status === 'initialized') {
    log('CodeGraph initialized .codegraph');
  } else if (codeGraph.status === 'unavailable') {
    warn('codegraph CLI not found — install it and run `codegraph init .`');
  } else {
    warn(`CodeGraph initialization failed (${codeGraph.detail}) — run \`codegraph init .\``);
  }

  // ── 7. Generated artifacts ────────────────────────────────────────────────────

  if (Bun.argv.includes('--skip-generate')) {
    log('generated artifacts deferred  bun run generate');
  } else {
    await Bun.$`bun run generate`.cwd(root);
  }

  // ── 8. Initialization summary ─────────────────────────────────────────────────

  const resolvedPorts: WorktreePorts = {
    AI_SDK_DEVTOOLS_PORT:
      envVars.get('AI_SDK_DEVTOOLS_PORT') || Bun.env.AI_SDK_DEVTOOLS_PORT || ports.AI_SDK_DEVTOOLS_PORT,
    MONAD_KV_UI_PORT: envVars.get('MONAD_KV_UI_PORT') || Bun.env.MONAD_KV_UI_PORT || ports.MONAD_KV_UI_PORT,
    MONAD_HTTP_PORT: envVars.get('MONAD_HTTP_PORT') || Bun.env.MONAD_HTTP_PORT || ports.MONAD_HTTP_PORT,
    MONAD_PORT: envVars.get('MONAD_PORT') || Bun.env.MONAD_PORT || ports.MONAD_PORT,
    UI_STORYBOOK_PORT: envVars.get('UI_STORYBOOK_PORT') || Bun.env.UI_STORYBOOK_PORT || ports.UI_STORYBOOK_PORT,
    WEB_PORT: envVars.get('WEB_PORT') || Bun.env.WEB_PORT || ports.WEB_PORT,
    WEB_STORYBOOK_PORT: envVars.get('WEB_STORYBOOK_PORT') || Bun.env.WEB_STORYBOOK_PORT || ports.WEB_STORYBOOK_PORT
  };

  process.stdout.write(
    buildDevInitSummary(
      {
        apiKeySet: Boolean(apiKey),
        monadHome,
        ports: resolvedPorts
      },
      { color }
    ).join('\n')
  );
}

if (import.meta.main) {
  await main();
}
