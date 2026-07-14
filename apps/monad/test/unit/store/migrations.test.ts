import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

interface MigrationJournal {
  entries: MigrationEntry[];
}

interface MigrationEntry {
  tag: string;
  when: number;
}

const drizzleDir = new URL('../../../drizzle/', import.meta.url);
const journalUrl = new URL('meta/_journal.json', drizzleDir);
const expectedMigrationTags = ['0000_initial-schema', '0001_message-fts'];
const partialIndexes = [
  'idx_acp_delegates_live',
  'idx_external_agent_sessions_live',
  'idx_external_agent_sessions_provider_ref',
  'idx_external_agent_inbox_delivery_id'
];

function loadJournal(): MigrationJournal {
  if (!existsSync(journalUrl)) return { entries: [] };
  return JSON.parse(readFileSync(journalUrl, 'utf8')) as MigrationJournal;
}

function applyMigration(db: Database, entry: MigrationEntry): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      hash TEXT NOT NULL,
      created_at NUMERIC
    );
  `);

  const applied = db.prepare('SELECT 1 FROM __drizzle_migrations WHERE hash = ?').get(entry.tag);
  if (applied) return;

  db.exec(readFileSync(new URL(`${entry.tag}.sql`, drizzleDir), 'utf8'));
  db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(entry.tag, entry.when);
}

function applyInitialHistory(db: Database, beforeCustomMigration?: (db: Database) => void): void {
  const journal = loadJournal();
  expect(journal.entries.map((entry) => entry.tag)).toEqual(expectedMigrationTags);

  const regularMigration = journal.entries[0];
  const customMigration = journal.entries[1];
  if (!regularMigration || !customMigration) throw new Error('initial Drizzle history is incomplete');

  applyMigration(db, regularMigration);
  beforeCustomMigration?.(db);
  applyMigration(db, customMigration);
}

function ftsRowIds(db: Database, table: 'messages_fts' | 'messages_fts_trigram', query: string): number[] {
  return (
    db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid`).all(query) as { rowid: number }[]
  ).map((row) => row.rowid);
}

test('initial Drizzle history creates the regular schema and partial indexes', () => {
  const db = new Database(':memory:');
  applyInitialHistory(db);

  expect((db.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get() as { count: number }).count).toBe(2);

  const embeddingColumns = (db.prepare('PRAGMA table_info(message_embeddings)').all() as { name: string }[]).map(
    (row) => row.name
  );
  expect(embeddingColumns).toEqual(['message_id', 'dim', 'vec', 'model']);

  const inboxColumns = (db.prepare('PRAGMA table_info(external_agent_inbox_items)').all() as { name: string }[]).map(
    (row) => row.name
  );
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

  const indexedSql = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
    .all() as {
    name: string;
    sql: string;
  }[];
  for (const name of partialIndexes) {
    const index = indexedSql.find((entry) => entry.name === name);
    expect(index).toBeDefined();
    if (!index) throw new Error(`missing partial index: ${name}`);
    expect(index.sql.toUpperCase()).toContain('WHERE');
  }
});

test('the custom FTS migration rebuilds existing messages and keeps both indexes synchronized', () => {
  const db = new Database(':memory:');
  applyInitialHistory(db, (regularDb) => {
    regularDb.exec(`
      INSERT INTO messages (id, transcript_target_id, role, text, created_at)
      VALUES ('before-fts', 'session-1', 'user', 'before rebuild content', '2026-07-14T00:00:00.000Z');
    `);
  });

  for (const table of ['messages_fts', 'messages_fts_trigram'] as const) {
    expect(
      (db.prepare(`SELECT sql FROM sqlite_master WHERE name = '${table}'`).get() as { sql: string }).sql
    ).toContain('fts5');
    expect(ftsRowIds(db, table, 'rebuild')).toHaveLength(1);
  }

  db.exec(`
    INSERT INTO messages (id, transcript_target_id, role, text, created_at)
    VALUES ('trigger-message', 'session-1', 'user', 'inserted token', '2026-07-14T00:00:01.000Z');
  `);
  for (const table of ['messages_fts', 'messages_fts_trigram'] as const) {
    expect(ftsRowIds(db, table, 'inserted')).toHaveLength(1);
  }

  db.exec("UPDATE messages SET text = 'updated token' WHERE id = 'trigger-message'");
  for (const table of ['messages_fts', 'messages_fts_trigram'] as const) {
    expect(ftsRowIds(db, table, 'inserted')).toHaveLength(0);
    expect(ftsRowIds(db, table, 'updated')).toHaveLength(1);
  }

  db.exec("DELETE FROM messages WHERE id = 'trigger-message'");
  for (const table of ['messages_fts', 'messages_fts_trigram'] as const) {
    expect(ftsRowIds(db, table, 'updated')).toHaveLength(0);
  }
});

test('the initial Drizzle history is idempotent', () => {
  const db = new Database(':memory:');
  applyInitialHistory(db);
  db.exec(
    "INSERT INTO usage_ledger (day, provider, model, category, updated_at) VALUES ('2026-07-14', 'openai', 'gpt-5', 'chat', '2026-07-14T00:00:00.000Z')"
  );
  applyInitialHistory(db);

  expect((db.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get() as { count: number }).count).toBe(2);
  expect((db.prepare('SELECT COUNT(*) AS count FROM usage_ledger').get() as { count: number }).count).toBe(1);
});
