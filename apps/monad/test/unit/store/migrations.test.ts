import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/bun-sqlite';

import { LATEST_MIGRATION_TIMESTAMP, MIGRATIONS } from '#/store/db/migrations.generated.ts';
import { hasCurrentMigration, migrate } from '#/store/db/migrations.ts';

interface MigrationJournal {
  entries: MigrationEntry[];
}

interface MigrationEntry {
  breakpoints: boolean;
  tag: string;
  when: number;
}

const drizzleDir = new URL('../../../drizzle/', import.meta.url);
const partialIndexes = [
  'idx_acp_delegates_live',
  'idx_external_agent_sessions_live',
  'idx_external_agent_sessions_provider_ref',
  'idx_external_agent_inbox_delivery_id'
];

function loadJournal(): MigrationJournal {
  return JSON.parse(readFileSync(new URL('meta/_journal.json', drizzleDir), 'utf8')) as MigrationJournal;
}

function migrateSqlite(sqlite: Database): void {
  migrate(drizzle(sqlite));
}

function ftsRowIds(sqlite: Database, table: 'messages_fts' | 'messages_fts_trigram', query: string): number[] {
  return (
    sqlite.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid`).all(query) as { rowid: number }[]
  ).map((row) => row.rowid);
}

test('generated migrations exactly embed the source Drizzle history', () => {
  const journal = loadJournal();
  const newest = journal.entries.at(-1);
  if (!newest) throw new Error('Drizzle migration journal has no entries');

  expect(LATEST_MIGRATION_TIMESTAMP).toBe(newest.when);
  expect(MIGRATIONS).toEqual(
    journal.entries.map((entry) => {
      const query = readFileSync(new URL(`${entry.tag}.sql`, drizzleDir), 'utf8');
      return {
        sql: query.split('--> statement-breakpoint'),
        bps: entry.breakpoints,
        folderMillis: entry.when,
        hash: createHash('sha256').update(query).digest('hex')
      };
    })
  );
});

test('runtime migrator records Drizzle hashes and the current journal state', () => {
  const sqlite = new Database(':memory:');
  const journal = loadJournal();

  migrateSqlite(sqlite);

  const applied = sqlite
    .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')
    .all() as Array<{ hash: string; created_at: number }>;
  expect(applied).toEqual(
    journal.entries.map((entry) => ({
      hash: createHash('sha256')
        .update(readFileSync(new URL(`${entry.tag}.sql`, drizzleDir)))
        .digest('hex'),
      created_at: entry.when
    }))
  );
  expect(hasCurrentMigration(sqlite)).toBe(true);

  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(LATEST_MIGRATION_TIMESTAMP);
  expect(hasCurrentMigration(sqlite)).toBe(false);
});

test('runtime migrator creates the regular schema and partial indexes', () => {
  const sqlite = new Database(':memory:');
  migrateSqlite(sqlite);

  const embeddingColumns = (sqlite.prepare('PRAGMA table_info(message_embeddings)').all() as { name: string }[]).map(
    (row) => row.name
  );
  expect(embeddingColumns).toEqual(['message_id', 'dim', 'vec', 'model']);

  const inboxColumns = (
    sqlite.prepare('PRAGMA table_info(external_agent_inbox_items)').all() as { name: string }[]
  ).map((row) => row.name);
  expect(inboxColumns).toEqual([
    'external_agent_session_id',
    'message_seq',
    'delivery_id',
    'project_id',
    'member_instance_id',
    'trigger_message_id',
    'provider_session_ref',
    'provider_turn_id',
    'error_summary',
    'state',
    'created_at',
    'delivered_at',
    'visible_at',
    'consumed_at',
    'updated_at'
  ]);

  const indexedSql = sqlite
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
    .all() as Array<{ name: string; sql: string }>;
  for (const name of partialIndexes) {
    const index = indexedSql.find((entry) => entry.name === name);
    expect(index).toBeDefined();
    if (!index) throw new Error(`missing partial index: ${name}`);
    expect(index.sql.toUpperCase()).toContain('WHERE');
  }
});

test('runtime migrator applies the custom FTS migration and stays idempotent', () => {
  const sqlite = new Database(':memory:');
  migrateSqlite(sqlite);

  sqlite.exec(`
    INSERT INTO messages (id, transcript_target_id, role, text, created_at)
    VALUES ('trigger-message', 'session-1', 'user', 'inserted token', '2026-07-14T00:00:01.000Z');
  `);
  for (const table of ['messages_fts', 'messages_fts_trigram'] as const) {
    expect(ftsRowIds(sqlite, table, 'inserted')).toHaveLength(1);
  }

  sqlite.exec("UPDATE messages SET text = 'updated token' WHERE id = 'trigger-message'");
  for (const table of ['messages_fts', 'messages_fts_trigram'] as const) {
    expect(ftsRowIds(sqlite, table, 'inserted')).toHaveLength(0);
    expect(ftsRowIds(sqlite, table, 'updated')).toHaveLength(1);
  }

  sqlite.exec("DELETE FROM messages WHERE id = 'trigger-message'");
  for (const table of ['messages_fts', 'messages_fts_trigram'] as const) {
    expect(ftsRowIds(sqlite, table, 'updated')).toHaveLength(0);
  }

  sqlite.exec(
    "INSERT INTO usage_ledger (day, provider, model, category, updated_at) VALUES ('2026-07-14', 'openai', 'gpt-5', 'chat', '2026-07-14T00:00:00.000Z')"
  );
  migrateSqlite(sqlite);
  expect((sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get() as { count: number }).count).toBe(
    loadJournal().entries.length
  );
  expect((sqlite.prepare('SELECT COUNT(*) AS count FROM usage_ledger').get() as { count: number }).count).toBe(1);
});
