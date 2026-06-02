// Migration scripts live in src/migrations/config/ (MonadConfig) and src/migrations/auth/ (MonadAuth).
// Naming convention: v{targetVersion}.ts, each exporting `migrate(prev: unknown): unknown`.
// The runner discovers scripts at runtime — no central registry to maintain.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

type MigrateFn = (prev: unknown) => unknown;

interface MigrationModule {
  migrate: MigrateFn;
}

function targetVersion(filename: string): number {
  return parseInt(filename.match(/^v(\d+)\./)?.[1] ?? '0', 10);
}

async function loadMigrations(dir: string): Promise<Map<number, MigrateFn>> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return new Map();
  }

  const files = entries
    .filter((f) => /^v\d+\.(ts|js|mts|mjs)$/.test(f))
    .sort((a, b) => targetVersion(a) - targetVersion(b));

  const map = new Map<number, MigrateFn>();

  for (const file of files) {
    const ver = targetVersion(file);
    const mod = (await import(join(dir, file))) as Partial<MigrationModule>;
    if (typeof mod.migrate !== 'function') {
      throw new Error(
        `Migration script ${file} must export a named function: export function migrate(prev: unknown): unknown`
      );
    }
    map.set(ver, mod.migrate);
  }

  return map;
}

export async function runMigrations<T>(
  raw: unknown,
  currentVersion: number,
  migrationsDir: string,
  parse: (data: unknown) => T
): Promise<T> {
  const stored = raw as Record<string, unknown> | null | undefined;
  const startVersion = typeof stored?.version === 'number' ? stored.version : null;

  if (startVersion === null) {
    throw new Error('Stored data has no version field — cannot migrate.');
  }
  if (startVersion > currentVersion) {
    throw new Error(
      `Stored version ${startVersion} is newer than the current version ${currentVersion}. ` +
        'Downgrade is not supported.'
    );
  }

  if (startVersion === currentVersion) return parse(raw);

  const migrations = await loadMigrations(migrationsDir);

  let data: unknown = raw;
  for (let v = startVersion; v < currentVersion; v++) {
    const next = v + 1;
    const migrate = migrations.get(next);
    if (!migrate) {
      throw new Error(
        `Missing migration script v${next}.ts in ${migrationsDir} ` + `(needed to upgrade v${v} → v${next})`
      );
    }
    data = migrate(data);
  }

  return parse(data);
}
