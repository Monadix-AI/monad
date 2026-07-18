#!/usr/bin/env bun
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
 *   4. Scaffolds packages/environment/config.init.json from config.init.json.template (dev seed) if missing,
 *      and warns if its apiKey is empty.
 *   5. Initializes CodeGraph when the local machine has it installed and this checkout is unindexed.
 *   6. Installs a worktree-local `monad` CLI shim under .dev/bin.
 *   7. Prints a connection summary (daemon URL, data dir).
 *   8. Regenerates checked-in/generated dev artifacts used by typecheck and local builds.
 *
 * The initialization body runs only when executed directly (import.meta.main); the pure
 * port helpers below are exported so dev-init.test.ts can unit-test them without
 * triggering any filesystem side effects.
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { installDevCliShim } from './dev-init/cli-shim';
import { runDevInitCommandStep } from './dev-init/command-step';
import { scaffoldDevSeed } from './dev-init/dev-seed';
import { buildMoSprite, reportCodeGraph, startPhoenix } from './dev-init/dev-services';
import { parseEnvFile, shouldSkipDevInit } from './dev-init/env';
import { installPostCheckoutHook } from './dev-init/git-hooks';
import { buildDevInitSummary, generatedArtifactsHeader, shouldColorOutput } from './dev-init/output';
import { ensurePortLines, removeBlankXdgLines, type WorktreePorts, worktreePorts } from './dev-init/ports';

export { devCliShimText, installDevCliShim } from './dev-init/cli-shim';
export { shouldRenderDevInitCommandSpinner } from './dev-init/command-step';
export {
  codeGraphStatus,
  isExpectedPhoenixImage,
  resolvePhoenixContainerImage,
  withSharedDirectoryLock
} from './dev-init/dev-services';
export { postCheckoutHookText } from './dev-init/git-hooks';
export {
  buildDevInitSummary,
  buildDevStepProgressFrame,
  buildDevStepStatusFrame,
  buildGeneratedArtifactProgressFrame,
  buildGeneratedArtifactStatusFrame
} from './dev-init/output';
export { ensurePortLines, portOffset, removeBlankXdgLines, worktreePorts } from './dev-init/ports';

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

  const apiKey = await scaffoldDevSeed(root, log, warn);

  await reportCodeGraph(root, log);

  // ── 4. Arize Phoenix (local LLM observability backend) ───────────────────────

  const otelUiUrl = await startPhoenix(color, log, warn);

  // ── 4b. Mo desktop sprite (macOS) ────────────────────────────────────────────

  await buildMoSprite(root, color, log, warn);

  // ── 5. Worktree-local CLI ──────────────────────────────────────────────────────

  const cliShimPath = await installDevCliShim(root);
  log(`CLI shim ready        ${cliShimPath}`);

  // ── 6. Initialization summary ─────────────────────────────────────────────────

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
        otelUiUrl,
        ports: resolvedPorts
      },
      { color }
    ).join('\n')
  );

  // ── 7. Generated dev artifacts ────────────────────────────────────────────────
  // In a direnv-authorized checkout, .envrc prepends .dev/bin so `monad <cmd>` runs
  // this worktree's TypeScript CLI directly. Authorization remains an explicit one-time step.

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

  const generatedArtifacts = [
    {
      command: ['bun', 'run', join(root, 'scripts/generate-codex-app-server-protocol.ts')],
      label: 'Codex app-server protocol',
      target: 'packages/atoms/generated/codex-app-server'
    },
    {
      command: ['bun', 'run', join(root, 'scripts/generate-avatar-styles.ts')],
      label: 'Avatar styles',
      target: 'packages/protocol/generated/avatar-styles.ts'
    },
    {
      command: ['bun', 'run', join(root, 'packages/environment/scripts/gen-config-schema.ts')],
      label: 'Config schemas',
      target: 'packages/environment/{config,agents,mesh,auth}.schema.json'
    },
    {
      command: ['bun', 'run', join(root, 'scripts/generate-licenses.ts')],
      label: 'License inventory',
      target: 'apps/monad/generated/licenses.json'
    }
  ];

  await Promise.all(generatedArtifacts.map(generateArtifact));
}

if (import.meta.main) {
  await main();
}
