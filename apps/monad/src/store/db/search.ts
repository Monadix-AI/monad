// Message search (FTS5 + trigram + LIKE) and embedding storage / semantic recall. Split out of
// index.ts — every function takes the raw bun:sqlite handle.

import type { Database } from 'bun:sqlite';
import type { SearchHit, SearchMode, TranscriptTargetId } from '@monad/protocol';

import { makeSnippet, type SearchRow } from './row-mappers.ts';

export interface SearchOptions {
  q: string;
  mode?: SearchMode;
  limit?: number;
  transcriptTargetId?: TranscriptTargetId;
}

/**
 * FTS5 (tokenized) + trigram (substring/CJK, queries ≥3 chars) + LIKE fallback.
 * `mode` semantic/hybrid degrade to keyword until embeddings are configured.
 */
export function searchMessages(sqlite: Database, opts: SearchOptions): SearchHit[] {
  const q = opts.q.trim();
  if (!q) return [];
  const limit = opts.limit ?? 20;
  const transcriptTargetId = opts.transcriptTargetId;
  const hits = new Map<string, SearchHit>();

  const add = (r: SearchRow, score: number): void => {
    if (hits.has(r.id)) return;
    hits.set(r.id, {
      transcriptTargetId: r.transcript_target_id as SearchHit['transcriptTargetId'],
      transcriptTargetTitle: r.stitle,
      messageId: r.id as SearchHit['messageId'],
      role: r.role as SearchHit['role'],
      snippet: makeSnippet(r.text, q),
      at: r.created_at,
      score,
      matchedBy: 'keyword'
    });
  };

  const ftsMatch = `"${q.replace(/"/g, '""')}"`; // phrase query — neutralizes FTS5 operators
  const queryFts = (table: 'messages_fts' | 'messages_fts_trigram'): void => {
    const where = `${table} MATCH $q AND m.active = 1${transcriptTargetId ? ' AND m.transcript_target_id = $target' : ''}`;
    const rows = sqlite
      .query(
        `SELECT m.id, m.transcript_target_id, m.role, m.text, m.created_at, COALESCE(s.title, p.title) AS stitle, bm25(${table}) AS rank
         FROM ${table} f
         JOIN messages m ON m.rowid = f.rowid
         LEFT JOIN sessions s ON s.id = m.transcript_target_id
         LEFT JOIN workplace_projects p ON p.id = m.transcript_target_id
         WHERE ${where}
         ORDER BY rank LIMIT $lim`
      )
      .all(
        transcriptTargetId ? { $q: ftsMatch, $target: transcriptTargetId, $lim: limit } : { $q: ftsMatch, $lim: limit }
      ) as SearchRow[];
    for (const r of rows) add(r, -(r.rank ?? 0)); // bm25 returns negative scores; negate for ranking
  };

  try {
    queryFts('messages_fts');
    if (q.length >= 3) queryFts('messages_fts_trigram');
  } catch {
    // malformed FTS query (e.g. unbalanced quotes) — fall through to LIKE
  }

  if (hits.size === 0) {
    const rows = sqlite
      .query(
        `SELECT m.id, m.transcript_target_id, m.role, m.text, m.created_at, COALESCE(s.title, p.title) AS stitle
         FROM messages m
         LEFT JOIN sessions s ON s.id = m.transcript_target_id
         LEFT JOIN workplace_projects p ON p.id = m.transcript_target_id
         WHERE m.active = 1 AND m.text LIKE $like${transcriptTargetId ? ' AND m.transcript_target_id = $target' : ''}
         ORDER BY m.rowid DESC LIMIT $lim`
      )
      .all(
        transcriptTargetId
          ? { $like: `%${q}%`, $target: transcriptTargetId, $lim: limit }
          : { $like: `%${q}%`, $lim: limit }
      ) as SearchRow[];
    for (const r of rows) add(r, 0.1);
  }

  return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Store/replace a message's embedding vector (raw little-endian float32 bytes). `model` records
 *  which embedding model produced it, so a later model switch can detect stale vectors. */
export function upsertEmbedding(sqlite: Database, messageId: string, vec: number[], model?: string): void {
  sqlite
    .query('INSERT OR REPLACE INTO message_embeddings (message_id, dim, vec, model) VALUES (?, ?, ?, ?)')
    .run(messageId, vec.length, new Uint8Array(Float32Array.from(vec).buffer), model ?? null);
}

/** Drop every stored embedding (used when the embedding model changes and the user opts to
 *  re-index from scratch). Returns how many vectors were cleared; the indexer then rebuilds. */
export function clearEmbeddings(sqlite: Database): number {
  const n = (sqlite.query('SELECT COUNT(*) AS n FROM message_embeddings').get() as { n: number }).n;
  sqlite.query('DELETE FROM message_embeddings').run();
  return n;
}

/**
 * Active messages with no embedding yet. `limit` caps the batch — pass it for an unscoped
 * (whole-corpus) backfill so a single request can't materialize + embed the entire DB at
 * once; a session-scoped call is already bounded by that session and can omit it.
 */
export function messagesMissingEmbedding(
  sqlite: Database,
  transcriptTargetId?: string,
  limit?: number
): { id: string; text: string }[] {
  const where = transcriptTargetId ? 'AND m.transcript_target_id = ?' : '';
  const cap = limit && limit > 0 ? ' LIMIT ?' : '';
  const binds: (string | number)[] = transcriptTargetId ? [transcriptTargetId] : [];
  if (cap) binds.push(limit as number);
  const rows = sqlite
    .query(
      `SELECT m.id, m.text FROM messages m
       LEFT JOIN message_embeddings e ON e.message_id = m.id
       WHERE e.message_id IS NULL AND m.active = 1 AND m.text != '' ${where}${cap}`
    )
    .all(...binds) as { id: string; text: string }[];
  return rows;
}

/** How many active, non-empty messages still lack an embedding — surfaced as an "indexing N
 *  left" hint so a semantic search can tell the user recall may be incomplete. */
export function pendingEmbeddingCount(sqlite: Database, transcriptTargetId?: string): number {
  const where = transcriptTargetId ? 'AND m.transcript_target_id = ?' : '';
  const binds = transcriptTargetId ? [transcriptTargetId] : [];
  const row = sqlite
    .query(
      `SELECT COUNT(*) AS n FROM messages m
       LEFT JOIN message_embeddings e ON e.message_id = m.id
       WHERE e.message_id IS NULL AND m.active = 1 AND m.text != '' ${where}`
    )
    .get(...binds) as { n: number };
  return row.n;
}

/** How many stored vectors were produced by a model OTHER than `currentModel` — i.e. stale after
 *  an embedding-model switch. Vectors with an unknown (NULL) model are not counted as stale. */
export function staleEmbeddingCount(sqlite: Database, currentModel: string): number {
  const row = sqlite
    .query('SELECT COUNT(*) AS n FROM message_embeddings WHERE model IS NOT NULL AND model != ?')
    .get(currentModel) as { n: number };
  return row.n;
}

export interface SearchSemanticOptions {
  limit?: number;
  transcriptTargetId?: TranscriptTargetId;
}

export function searchSemantic(sqlite: Database, queryVec: number[], opts: SearchSemanticOptions = {}): SearchHit[] {
  const limit = opts.limit ?? 20;
  // Precompute the query norm ONCE — cosine() used to recompute it for every row (N redundant
  // O(dim) passes). A zero/empty query can't match anything.
  let qNorm = 0;
  for (const x of queryVec) qNorm += x * x;
  qNorm = Math.sqrt(qNorm);
  if (qNorm === 0) return [];

  // Lean scan: pull only (id, vec) for active rows of the matching dimension — NOT each row's
  // text/title (transferring N message bodies just to drop all but `limit` is the dominant waste).
  // Still a linear scan: bun:sqlite can't load sqlite-vec, so there's no native ANN index to use.
  const where = opts.transcriptTargetId ? 'AND m.transcript_target_id = ?' : '';
  const rows = sqlite
    .query(
      `SELECT e.message_id AS id, e.vec AS vec
       FROM message_embeddings e
       JOIN messages m ON m.id = e.message_id
       WHERE e.dim = ? AND m.active = 1 ${where}`
    )
    .all(queryVec.length, ...(opts.transcriptTargetId ? [opts.transcriptTargetId] : [])) as {
    id: string;
    vec: Uint8Array;
  }[];

  const scored: { id: string; score: number }[] = [];
  for (const r of rows) {
    const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
    if (v.length !== queryVec.length) continue;
    let dot = 0;
    let vn = 0;
    for (let i = 0; i < v.length; i++) {
      const y = v[i] as number;
      dot += (queryVec[i] as number) * y;
      vn += y * y;
    }
    if (vn === 0) continue;
    scored.push({ id: r.id, score: dot / (qNorm * Math.sqrt(vn)) });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  if (top.length === 0) return [];

  // Now fetch display fields for just the winners (≤ limit rows).
  const placeholders = top.map(() => '?').join(',');
  const display = sqlite
    .query(
      `SELECT m.id, m.transcript_target_id, m.role, m.text, m.created_at, COALESCE(s.title, p.title) AS stitle
       FROM messages m
       LEFT JOIN sessions s ON s.id = m.transcript_target_id
       LEFT JOIN workplace_projects p ON p.id = m.transcript_target_id
       WHERE m.id IN (${placeholders})`
    )
    .all(...top.map((t) => t.id)) as SearchRow[];
  const byId = new Map(display.map((r) => [r.id, r]));

  return top.flatMap(({ id, score }) => {
    const r = byId.get(id);
    if (!r) return [];
    return [
      {
        transcriptTargetId: r.transcript_target_id as SearchHit['transcriptTargetId'],
        transcriptTargetTitle: r.stitle,
        messageId: r.id as SearchHit['messageId'],
        role: r.role as SearchHit['role'],
        snippet: r.text.length > 80 ? `${r.text.slice(0, 80)}…` : r.text,
        at: r.created_at,
        score,
        matchedBy: 'semantic' as const
      }
    ];
  });
}
