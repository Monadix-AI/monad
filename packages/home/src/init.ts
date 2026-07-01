import type { MonadPaths } from './paths.ts';

import { access, chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { newId } from '@monad/protocol';

import {
  createDefaultConfig,
  loadAll,
  loadAuth,
  PROFILE_SCHEMA_CONTENT,
  SCHEMA_CONTENT,
  saveAll,
  saveAuth,
  setSchemaRuntimeDir
} from './config.ts';
import { TEMPLATES } from './templates-embed.ts';

export interface InitOptions {
  /** Human-readable name for the owner principal. Defaults to $USER or "". */
  displayName?: string;
  /**
   * Re-seed workspace starter files even if they already exist (`monad init --upgrade`).
   * Config and auth are never overwritten on upgrade.
   */
  reseed?: boolean;
}

export interface InitResult {
  created: boolean; // true on first run, false on idempotent re-run
  principalId: string;
}

/** Ensure ~/.monad/ is fully initialised. Safe to call on every daemon startup — all steps are idempotent. */
export async function initMonadHome(paths: MonadPaths, opts: InitOptions = {}): Promise<InitResult> {
  const displayName = opts.displayName ?? Bun.env.USER ?? '';

  await mkdir(paths.home, { recursive: true });
  // The daemon's Unix socket lives under paths.runtime and grants UNAUTHENTICATED RPC to anyone who
  // can reach it, so the directory's perms are part of its access control (security-guidelines.md §3:
  // "create ~/.monad/run/ as 0o700"). mkdir's mode only applies on creation, so also chmod an existing
  // dir. POSIX only — chmod is a no-op on Windows, where %APPDATA%\monad is already per-user via ACL.
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(paths.runtime, 0o700).catch(() => {});
  await mkdir(paths.backup, { recursive: true });
  await mkdir(paths.dbDir, { recursive: true }); // main sqlite + mem0 history + qdrant storage
  // config.json / profile.json reference their schema via a `$schema` file:// URL. In dev that
  // URL points at the repo source (live edits), so the schema is only materialized under .monad/
  // for release builds — where setSchemaRuntimeDir then flips the URL to this single location.
  if (Bun.env.NODE_ENV !== 'development') {
    await Bun.write(join(paths.runtime, 'config.schema.json'), SCHEMA_CONTENT);
    await Bun.write(join(paths.runtime, 'profile.schema.json'), PROFILE_SCHEMA_CONTENT);
    setSchemaRuntimeDir(paths.runtime);
  }
  await mkdir(paths.configs, { recursive: true });
  await mkdir(paths.bin, { recursive: true });
  await mkdir(paths.agents, { recursive: true });
  await mkdir(paths.workspace, { recursive: true });
  await mkdir(paths.cache, { recursive: true });
  await mkdir(join(paths.cache, 'logs'), { recursive: true });
  await mkdir(paths.atoms, { recursive: true });
  // packs/providers/skills are always materialized (discovery + the starter-skill seed expect them).
  // mcp/ and locales/ are created lazily by their installers — an unconfigured daemon stays tolerant
  // of their absence (the loaders already are).
  await Promise.all([
    mkdir(paths.packs, { recursive: true }),
    mkdir(paths.providers, { recursive: true }),
    mkdir(paths.skills, { recursive: true })
  ]);

  // credentials/ is locked down at the OS level: no agent tool or MCP call may access it
  // without an explicit user approval gate (enforced in main.ts withCredentialsProtection).
  await mkdir(paths.credentials, { recursive: true });
  if (process.platform === 'win32') {
    const username = Bun.env.USERNAME ?? Bun.env.USER ?? '';
    await Bun.$`icacls ${paths.credentials} /inheritance:r /grant:r "${username}:(OI)(CI)F"`.quiet();
  } else {
    await chmod(paths.credentials, 0o700);
  }

  // Preserve existing principal.id across re-runs.
  const existing = await loadAll(paths.config, paths.profile);
  const created = existing === null;
  const principalId = existing?.principal.id ?? newId('prn');

  if (created) {
    await saveAll(paths.config, paths.profile, createDefaultConfig(principalId, displayName));
  }

  // Create empty credential pool on first run; never overwrite existing auth.
  const existingAuth = await loadAuth(paths.auth);
  if (existingAuth === null) {
    await saveAuth(paths.auth, {
      version: 1,
      activeProvider: null,
      updatedAt: new Date().toISOString(),
      credentialPool: {}
    });
  }

  await Promise.all([
    seedFromTemplate(TEMPLATES['SOUL.md'], join(paths.workspace, 'SOUL.md'), opts.reseed),
    seedFromTemplate(TEMPLATES['AGENT.md'], join(paths.workspace, 'AGENT.md'), opts.reseed),
    seedFromTemplate(TEMPLATES['USER.md'], join(paths.workspace, 'USER.md'), opts.reseed),
    seedFromTemplate(
      TEMPLATES['model-provider.sample.md'],
      join(paths.workspace, 'templates/model-provider.sample.md'),
      opts.reseed
    )
  ]);

  // Seed only on first init (or reseed) so a user-deleted example stays deleted.
  if (created || opts.reseed) {
    await Promise.all([
      seedFromTemplate(
        TEMPLATES['skills/summarize-changes.md'],
        join(paths.skills, 'summarize-changes/SKILL.md'),
        opts.reseed
      ),
      seedFromTemplate(
        TEMPLATES['skills/summarize-changes.md'],
        join(paths.workspace, 'skills/summarize-changes/SKILL.md'),
        opts.reseed
      ),
      seedMonadTestAtomPack(paths, opts.reseed)
    ]);
  }

  return { created, principalId };
}

async function seedMonadTestAtomPack(paths: MonadPaths, force = false): Promise<void> {
  const packDir = join(paths.packs, 'monad-test');
  const manifest = {
    name: 'monad-test',
    version: '1.0.0',
    sdkVersion: '0',
    atoms: ['skill'],
    entry: 'dist/atom-pack.js',
    description: 'Built-in starter atom pack with a sample skill.',
    author: 'monad'
  };
  await Promise.all([
    seedJson(manifest, join(packDir, 'atom-pack.json'), force),
    seedJson(
      {
        source: 'builtin:monad-test',
        sourceId: 'builtin:monad-test',
        sourceKind: 'builtin',
        grantedAtoms: ['skill'],
        enabled: true
      },
      join(packDir, '.install.json'),
      force
    ),
    seedText(
      `export default { manifest: ${JSON.stringify(manifest)}, register() {} };\n`,
      join(packDir, 'dist/atom-pack.js'),
      force
    ),
    seedFromTemplate(
      TEMPLATES['skills/summarize-changes.md'],
      join(packDir, 'skills/summarize-changes/SKILL.md'),
      force
    )
  ]);
}

async function seedFromTemplate(templatePath: string, filePath: string, force = false): Promise<void> {
  await seedFile(Bun.file(templatePath), filePath, force);
}

async function seedJson(value: unknown, filePath: string, force = false): Promise<void> {
  await seedText(`${JSON.stringify(value, null, 2)}\n`, filePath, force);
}

async function seedText(content: string, filePath: string, force = false): Promise<void> {
  await seedFile(content, filePath, force);
}

async function seedFile(content: Blob | string, filePath: string, force = false): Promise<void> {
  if (!force) {
    try {
      await access(filePath);
      return; // already exists — leave user content untouched
    } catch {
      /* ENOENT — fall through to write */
    }
  }
  await mkdir(dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
}
