import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';

import { configureSqliteConnection } from '#/store/db/connection.ts';
import { createStore } from '#/store/db/index.ts';
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
  'idx_mesh_sessions_live',
  'idx_mesh_sessions_provider_ref',
  'idx_mesh_agent_inbox_delivery_id'
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

function pragmaValue(store: ReturnType<typeof createStore>, pragma: string): string | number {
  const row = store.db.get(sql.raw(`PRAGMA ${pragma}`)) as Record<string, string | number> | undefined;
  if (!row) throw new Error(`missing PRAGMA result: ${pragma}`);
  const value = Object.values(row)[0];
  if (value === undefined) throw new Error(`missing PRAGMA value: ${pragma}`);
  return value;
}

test('session storage has no branch lineage columns', () => {
  const store = createStore();
  const sqlite = (store as unknown as { sqlite: Database }).sqlite;
  const columns = (sqlite.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((row) => row.name);

  expect(columns).not.toContain('parent_session_id');
  expect(columns).not.toContain('branched_at_message_id');
});

test('Store configures connection-local PRAGMAs for in-memory databases', () => {
  const store = createStore();
  try {
    expect(pragmaValue(store, 'foreign_keys')).toBe(1);
    expect(pragmaValue(store, 'synchronous')).toBe(1);
    expect(pragmaValue(store, 'journal_mode')).toBe('memory');
  } finally {
    store.close();
  }
});

test('file-backed Store reports configured connection PRAGMA values', async () => {
  const path = join(tmpdir(), `monad-store-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  let store: ReturnType<typeof createStore> | undefined;
  try {
    store = createStore({ path });
    expect(pragmaValue(store, 'foreign_keys')).toBe(1);
    expect(pragmaValue(store, 'synchronous')).toBe(1);
    expect(pragmaValue(store, 'journal_mode')).toBe('wal');
  } finally {
    store?.close();
    await rm(path, { force: true });
    await rm(`${path}-shm`, { force: true });
    await rm(`${path}-wal`, { force: true });
  }
});

test('WAL configuration rejects a malformed journal mode with its diagnostic', () => {
  const sqlite = {
    prepare: () => ({ get: () => ({ journal_mode: 42 }) }),
    exec: () => {}
  } as unknown as Database;

  expect(() => configureSqliteConnection(sqlite, 'malformed.sqlite')).toThrow(
    'SQLite WAL mode was not enabled for malformed.sqlite: 42'
  );
});

test('generated migrations exactly embed the source Drizzle history', () => {
  const journal = loadJournal();
  const newest = journal.entries.at(-1);
  if (!newest) throw new Error('Drizzle migration journal has no entries');

  expect(journal.entries.map((entry) => entry.tag)).toEqual(['0000_initial-schema', '0001_message-fts']);
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

  const meshSessionColumns = (sqlite.prepare('PRAGMA table_info(mesh_sessions)').all() as { name: string }[]).map(
    (row) => row.name
  );
  expect(meshSessionColumns).toEqual([
    'id',
    'transcript_target_id',
    'agent_name',
    'provider',
    'working_path',
    'runtime_role',
    'agent_runtime_id',
    'agent_runtime_token_hash',
    'last_delivered_seq',
    'last_visible_seq',
    'state',
    'pid',
    'provider_session_ref',
    'exit_code',
    'started_at',
    'updated_at',
    'exited_at'
  ]);

  expect(
    sqlite
      .prepare(
        "SELECT name, type FROM sqlite_master WHERE name IN ('messages_fts', 'messages_fts_trigram', 'messages_ai', 'messages_ad', 'messages_au') ORDER BY name"
      )
      .all()
  ).toEqual([
    { name: 'messages_ad', type: 'trigger' },
    { name: 'messages_ai', type: 'trigger' },
    { name: 'messages_au', type: 'trigger' },
    { name: 'messages_fts', type: 'table' },
    { name: 'messages_fts_trigram', type: 'table' }
  ]);

  const embeddingColumns = (sqlite.prepare('PRAGMA table_info(message_embeddings)').all() as { name: string }[]).map(
    (row) => row.name
  );
  expect(embeddingColumns).toEqual(['message_id', 'dim', 'vec', 'model']);

  const inboxColumns = (sqlite.prepare('PRAGMA table_info(mesh_agent_inbox_items)').all() as { name: string }[]).map(
    (row) => row.name
  );
  expect(inboxColumns).toEqual([
    'mesh_session_id',
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
  expect(
    partialIndexes.map((name) => ({
      hasPredicate:
        indexedSql
          .find((entry) => entry.name === name)
          ?.sql.toUpperCase()
          .includes('WHERE') ?? false,
      name
    }))
  ).toEqual(partialIndexes.map((name) => ({ hasPredicate: true, name })));
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
