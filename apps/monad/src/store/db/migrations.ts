import type { Database } from 'bun:sqlite';

// Pre-release: migrations are additive (new table = new version). Edit existing tables freely and
// delete/recreate dev DBs as needed; never rename/drop columns in existing migrations.
export const CURRENT_SCHEMA_VERSION = 2;

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sessions (
  id                      TEXT PRIMARY KEY,
  title                   TEXT NOT NULL,
  owner_principal_id      TEXT NOT NULL,
  state                   TEXT NOT NULL,
  agent_ids               TEXT NOT NULL DEFAULT '[]',
  parent_session_id       TEXT,
  branched_at_message_id  TEXT,
  archived                INTEGER NOT NULL DEFAULT 0,
  restore_count           INTEGER NOT NULL DEFAULT 0,
  model                   TEXT,
  cwd                     TEXT,
  origin                  TEXT,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  total_tokens            INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens      INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens        INTEGER NOT NULL DEFAULT 0,
  cost_usd                REAL NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS workplace_projects (
  id                      TEXT PRIMARY KEY,
  title                   TEXT NOT NULL,
  owner_principal_id      TEXT NOT NULL,
  state                   TEXT NOT NULL,
  archived                INTEGER NOT NULL DEFAULT 0,
  model                   TEXT,
  cwd                     TEXT,
  origin                  TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workplace_projects_state ON workplace_projects(state, archived);

-- Global usage accounting ("账本") — a (local-day, provider, model, category) rollup, monotonic,
-- survives session deletion. Only a manual clearLedger() resets it. Distinct from per-session usage
-- (reset on session reset). The time + category dimensions back the Usage tab's by-day/by-category views.
CREATE TABLE IF NOT EXISTS usage_ledger (
  day                 TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'chat',
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (day, provider, model, category)
);

CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  title              TEXT NOT NULL,
  assignee_agent_id  TEXT,
  depends_on         TEXT NOT NULL DEFAULT '[]',
  state              TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 0,
  result             TEXT,
  error              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  transcript_target_id TEXT NOT NULL,
  role          TEXT NOT NULL,
  text          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'text',
  data          TEXT,
  stream_status TEXT NOT NULL DEFAULT 'settled',
  active        INTEGER NOT NULL DEFAULT 1,
  include_in_context INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_transcript_target ON messages(transcript_target_id);
CREATE INDEX IF NOT EXISTS idx_messages_active ON messages(transcript_target_id, active);

CREATE TABLE IF NOT EXISTS memory (
  session_id  TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (session_id, key)
);

-- Durable event log — the post-completion tier behind the in-process RoundCache.
CREATE TABLE IF NOT EXISTS events (
  id                TEXT PRIMARY KEY,
  transcript_target_id TEXT NOT NULL,
  type              TEXT NOT NULL,
  actor_agent_id    TEXT,
  task_id           TEXT,
  payload           TEXT NOT NULL,
  at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_transcript_target ON events(transcript_target_id, id);

-- Channel atom: CORE-owned conversation→session mapping (the atom never sees session ids).
-- One row per (channel, conversation) holds the CURRENT active session pointer; it is repointed
-- by /new, /switch, or a reset policy.
CREATE TABLE IF NOT EXISTS channel_conversations (
  channel_id        TEXT NOT NULL,
  conversation_key  TEXT NOT NULL,
  active_session_id TEXT NOT NULL,
  principal_id      TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  PRIMARY KEY (channel_id, conversation_key)
);
-- Every session a conversation has ever opened — backs /sessions list and /switch.
CREATE TABLE IF NOT EXISTS channel_conversation_sessions (
  channel_id       TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  label            TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (channel_id, conversation_key, session_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_conv_sessions_session ON channel_conversation_sessions(session_id);

-- Full-text search over message bodies. Two external-content FTS5 tables:
--  · messages_fts        : unicode61 — tokenized word search (ASCII/whitespace langs)
--  · messages_fts_trigram: trigram   — substring/CJK recall (queries need >= 3 chars)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(text, content='messages', content_rowid='rowid');
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram
  USING fts5(text, content='messages', content_rowid='rowid', tokenize='trigram');

-- Semantic-search vectors. bun:sqlite cannot load the sqlite-vec extension (its bundled
-- SQLite disables dynamic extension loading), so embeddings live in a plain table and
-- cosine similarity is computed in JS. Small-scale; populated only when an embedding model
-- is configured. The vec column holds raw little-endian float32s (Float32Array bytes).
-- The model column records which embedding model produced each vector, so switching
-- roles.embedding can detect stale vectors (different model/dim) instead of silently mixing them.
CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id TEXT PRIMARY KEY,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  model      TEXT
);

-- Keep both FTS indexes in sync with the messages table.
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  INSERT INTO messages_fts_trigram(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  INSERT INTO messages_fts_trigram(rowid, text) VALUES (new.rowid, new.text);
END;

-- ACP delegate lifecycle ledger. One row per (parent session, agent) per spawn:
--   · evicted_at NULL  → currently live (used to detect orphaned processes on restart)
--   · evicted_at set   → historical; prune after retention window
-- reuse_count = how many times the live delegate was reused (1st use = 0).
-- prompt_count = total successful session/prompt calls served.
CREATE TABLE IF NOT EXISTS acp_delegates (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  agent_name      TEXT NOT NULL,
  acp_session_id  TEXT NOT NULL,
  pid             INTEGER NOT NULL,
  spawned_at      TEXT NOT NULL,
  last_used_at    TEXT NOT NULL,
  evicted_at      TEXT,
  evict_reason    TEXT,
  reuse_count     INTEGER NOT NULL DEFAULT 0,
  prompt_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_acp_delegates_session ON acp_delegates(session_id);
CREATE INDEX IF NOT EXISTS idx_acp_delegates_live ON acp_delegates(evicted_at) WHERE evicted_at IS NULL;

CREATE TABLE IF NOT EXISTS native_cli_sessions (
  id                    TEXT PRIMARY KEY,
  transcript_target_id  TEXT NOT NULL,
  agent_name            TEXT NOT NULL,
  provider              TEXT NOT NULL,
  working_path          TEXT NOT NULL,
  launch_mode           TEXT NOT NULL,
  runtime_role          TEXT NOT NULL DEFAULT 'interactive',
  agent_runtime_id      TEXT,
  agent_runtime_token_hash TEXT,
  last_delivered_seq    INTEGER NOT NULL DEFAULT 0,
  last_visible_seq      INTEGER NOT NULL DEFAULT 0,
  state                 TEXT NOT NULL,
  pid                   INTEGER,
  provider_session_ref  TEXT,
  output_snapshot       TEXT NOT NULL DEFAULT '',
  exit_code             INTEGER,
  started_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  exited_at             TEXT
);
CREATE INDEX IF NOT EXISTS idx_native_cli_sessions_transcript_target ON native_cli_sessions(transcript_target_id);
CREATE INDEX IF NOT EXISTS idx_native_cli_sessions_live ON native_cli_sessions(state)
  WHERE state IN ('starting', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_native_cli_sessions_provider_ref
  ON native_cli_sessions(transcript_target_id, provider, provider_session_ref)
  WHERE provider_session_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS native_agent_direct_messages (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  native_cli_session_id TEXT NOT NULL,
  from_agent            TEXT,
  peer                  TEXT NOT NULL,
  text                  TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_native_agent_direct_messages_session_peer
  ON native_agent_direct_messages(native_cli_session_id, peer, created_at);
CREATE INDEX IF NOT EXISTS idx_native_agent_direct_messages_project_pair
  ON native_agent_direct_messages(project_id, from_agent, peer, created_at);

CREATE TABLE IF NOT EXISTS channel_moderator_rounds (
  id                 TEXT PRIMARY KEY,
  channel_id         TEXT NOT NULL,
  moderator_key      TEXT NOT NULL,
  moderator_agent_id TEXT NOT NULL,
  original_inbound   TEXT NOT NULL,
  depth              INTEGER NOT NULL,
  tasks              TEXT NOT NULL,
  results            TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL,
  deadline_at        TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_moderator_rounds_open
  ON channel_moderator_rounds(channel_id, status, deadline_at);

CREATE TABLE IF NOT EXISTS native_cli_inbox_items (
  native_cli_session_id TEXT NOT NULL,
  message_seq           INTEGER NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'queued',
  created_at            TEXT NOT NULL,
  delivered_at          TEXT,
  visible_at            TEXT,
  consumed_at           TEXT,
  PRIMARY KEY (native_cli_session_id, message_seq)
);
CREATE INDEX IF NOT EXISTS idx_native_cli_inbox_items_pending
  ON native_cli_inbox_items(native_cli_session_id, state, message_seq);

PRAGMA user_version = 1;
    `.trim()
  },
  {
    version: 2,
    // Wrapped in a transaction because of the non-idempotent ALTER: either the whole block (incl.
    // user_version = 2) lands or none of it does, so a crash can't leave a half-applied v2 that
    // fails on re-run.
    sql: `
BEGIN;

-- Message attachment REGISTRY: a message can reference a local file (human-readable payload —
-- a report, a spilled long body). Only the reference + a metadata snapshot is stored; content
-- stays in the file and is read on demand by the wall preview/download endpoint. Registered ids
-- gate that endpoint: it serves only files an agent actually referenced from a message.
CREATE TABLE IF NOT EXISTS message_attachments (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  preview     TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_attachments_project
  ON message_attachments(project_id);

-- JSON array of message_attachments ids referenced by the direct message (NULL = none).
ALTER TABLE native_agent_direct_messages ADD COLUMN attachment_ids TEXT;

PRAGMA user_version = 2;

COMMIT;
    `.trim()
  }
];

/**
 * PRAGMA user_version is set at the end of each migration SQL block, so a crash
 * mid-migration leaves it at the previous value and the migration re-runs on next start.
 */
export function migrate(sqlite: Database): void {
  const row = sqlite.prepare('PRAGMA user_version').get() as { user_version: number };
  const current = row.user_version;

  for (const m of MIGRATIONS) {
    if (m.version > current) {
      sqlite.exec(m.sql);
    }
  }
}
