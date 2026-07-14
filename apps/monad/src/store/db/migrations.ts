import type { Database } from 'bun:sqlite';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { MigrationConfig } from 'drizzle-orm/migrator';
import type { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

import { LATEST_MIGRATION_TIMESTAMP, MIGRATIONS } from './migrations.generated.ts';

// Kept until Task 3 moves Home integrity checks to hasCurrentMigration().
export const CURRENT_SCHEMA_VERSION = LATEST_MIGRATION_TIMESTAMP;
const config: MigrationConfig = { migrationsFolder: '<embedded>' };

export function migrate(db: BunSQLiteDatabase): void {
  // Drizzle uses these runtime fields in its own Bun migrator, but 0.45.2 omits them from the emitted database type.
  const migrationDb = db as BunSQLiteDatabase & {
    readonly dialect: SQLiteSyncDialect;
    readonly session: Parameters<SQLiteSyncDialect['migrate']>[1];
  };
  migrationDb.dialect.migrate(MIGRATIONS, migrationDb.session, config);
}

export function hasCurrentMigration(sqlite: Database): boolean {
  try {
    const newest = sqlite
      .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
      .get() as { created_at: number } | null;
    return newest !== null && Number(newest.created_at) === LATEST_MIGRATION_TIMESTAMP;
  } catch {
    return false;
  }
}
