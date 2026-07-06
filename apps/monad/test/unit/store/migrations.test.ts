import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { CURRENT_SCHEMA_VERSION, migrate } from '@/store/db/migrations.ts';

// Pre-release: migrations are additive. These tests assert migrate() builds the current
// shape on a fresh DB and is safe to re-run.

test('migrate() builds the current schema and stamps user_version', () => {
  const db = new Database(':memory:');
  migrate(db);

  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
    CURRENT_SCHEMA_VERSION
  );

  const _ledgerCols = (db.prepare('PRAGMA table_info(usage_ledger)').all() as { name: string }[]).map((c) => c.name);

  const _embedCols = (db.prepare('PRAGMA table_info(message_embeddings)').all() as { name: string }[]).map(
    (c) => c.name
  );

  const _sessionCols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name);

  const acpCols = (db.prepare('PRAGMA table_info(acp_delegates)').all() as { name: string }[]).map((c) => c.name);
  for (const col of [
    'id',
    'session_id',
    'agent_name',
    'acp_session_id',
    'pid',
    'spawned_at',
    'last_used_at',
    'evicted_at',
    'evict_reason',
    'reuse_count',
    'prompt_count'
  ]) {
    expect(acpCols).toContain(col);
  }

  const nativeCliCols = (db.prepare('PRAGMA table_info(native_cli_sessions)').all() as { name: string }[]).map(
    (c) => c.name
  );
  for (const col of [
    'id',
    'transcript_target_id',
    'agent_name',
    'provider',
    'working_path',
    'launch_mode',
    'state',
    'pid',
    'provider_session_ref',
    'runtime_role',
    'agent_runtime_id',
    'agent_runtime_token_hash',
    'last_delivered_seq',
    'last_visible_seq',
    'output_snapshot',
    'exit_code',
    'started_at',
    'updated_at',
    'exited_at'
  ]) {
    expect(nativeCliCols).toContain(col);
  }
  const nativeCliIndexes = db.prepare('PRAGMA index_list(native_cli_sessions)').all() as {
    name: string;
    unique: number;
  }[];
  expect(nativeCliIndexes).toContainEqual(
    expect.objectContaining({ name: 'idx_native_cli_sessions_provider_ref', unique: 1 })
  );

  const nativeInboxCols = (db.prepare('PRAGMA table_info(native_cli_inbox_items)').all() as { name: string }[]).map(
    (c) => c.name
  );
  for (const col of [
    'native_cli_session_id',
    'message_seq',
    'state',
    'created_at',
    'delivered_at',
    'visible_at',
    'consumed_at'
  ]) {
    expect(nativeInboxCols).toContain(col);
  }
  const nativeInboxIndexes = db.prepare('PRAGMA index_list(native_cli_inbox_items)').all() as {
    name: string;
  }[];
  expect(nativeInboxIndexes).toContainEqual(expect.objectContaining({ name: 'idx_native_cli_inbox_items_pending' }));

  const nativeDirectCols = (
    db.prepare('PRAGMA table_info(native_agent_direct_messages)').all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  for (const col of ['id', 'project_id', 'native_cli_session_id', 'from_agent', 'peer', 'text', 'created_at']) {
    expect(nativeDirectCols).toContain(col);
  }
  const nativeDirectIndexes = db.prepare('PRAGMA index_list(native_agent_direct_messages)').all() as {
    name: string;
  }[];
  expect(nativeDirectIndexes).toContainEqual(
    expect.objectContaining({ name: 'idx_native_agent_direct_messages_session_peer' })
  );
  expect(nativeDirectIndexes).toContainEqual(
    expect.objectContaining({ name: 'idx_native_agent_direct_messages_project_pair' })
  );
});

test('migrate() is idempotent — running again is a no-op', () => {
  const db = new Database(':memory:');
  migrate(db);
  db.exec(
    `INSERT INTO usage_ledger (day, provider, model, category, updated_at)
       VALUES ('2026-01-15', 'anthropic', 'claude-x', 'chat', '2026-01-15T08:30:00.000Z')`
  );
  migrate(db);
  expect((db.prepare('SELECT COUNT(*) AS n FROM usage_ledger').get() as { n: number }).n).toBe(1);
});
