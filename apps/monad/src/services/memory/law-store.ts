// L3 inferred "laws" — general, falsifiable rules generalized from a scope's L1 facts + L2 graph.
// Persisted in the shared db/memory.sqlite (its own `graph_law` table — no new DB file): laws are
// derived knowledge like the graph. Re-derivation is wholesale per scope (replaceLaws), so there's no
// incremental support reconciliation to get wrong — each /infer-laws run replaces a scope's laws.

import { Database } from 'bun:sqlite';
import { z } from 'zod';

const LAW_DDL = `
CREATE TABLE IF NOT EXISTS graph_law (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  statement TEXT NOT NULL,
  norm_statement TEXT NOT NULL,
  support TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  contradicted_by TEXT,
  UNIQUE(scope, norm_statement)
);
CREATE INDEX IF NOT EXISTS idx_law_scope ON graph_law(scope);
`;

export interface LawInput {
  scope: string;
  statement: string;
  support?: string[];
  confidence: number;
}
export interface Law {
  id: string;
  scope: string;
  statement: string;
  support: string[];
  confidence: number;
  updatedAt: number;
  /** The text of a current fact that contradicts this law, or null. Set by /check-memory; cleared
   *  when the law is re-derived (replaceLaws). A contradicted law is suppressed from recall. */
  contradictedBy: string | null;
}

interface LawRow {
  id: string;
  scope: string;
  statement: string;
  support: string;
  confidence: number;
  updated_at: number;
  contradicted_by: string | null;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
const hash = (...p: string[]): string => new Bun.CryptoHasher('sha256').update(p.join(' ')).digest('hex').slice(0, 24);

export class LawStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;'); // shares memory.sqlite with graph + consolidation state
    this.db.exec(LAW_DDL);
    // Pre-release: bring an existing graph_law table up to the current shape without a migration file.
    try {
      this.db.exec('ALTER TABLE graph_law ADD COLUMN contradicted_by TEXT');
    } catch {
      // column already present — nothing to do.
    }
  }

  /** Wholesale re-derivation: drop this scope's laws and insert the freshly inferred set. */
  replaceLaws(scope: string, laws: LawInput[]): void {
    const now = Date.now();
    const tx = this.db.transaction((rows: LawInput[]) => {
      this.db.query('DELETE FROM graph_law WHERE scope = $s').run({ $s: scope });
      const seen = new Set<string>();
      for (const l of rows) {
        const statement = l.statement.trim();
        if (!statement) continue;
        const normStmt = norm(statement);
        if (seen.has(normStmt)) continue; // dedup within the batch
        seen.add(normStmt);
        this.db
          .query(
            `INSERT INTO graph_law (id, scope, statement, norm_statement, support, confidence, updated_at)
             VALUES ($id, $scope, $stmt, $norm, $support, $conf, $now)`
          )
          .run({
            $id: hash(scope, normStmt),
            $scope: scope,
            $stmt: statement,
            $norm: normStmt,
            $support: JSON.stringify(l.support ?? []),
            $conf: Math.max(0, Math.min(1, l.confidence)),
            $now: now
          });
      }
    });
    tx(laws);
  }

  listLaws(scopes: string[]): Law[] {
    if (scopes.length === 0) return [];
    return (
      this.db
        .query(`SELECT * FROM graph_law WHERE scope IN (${scopes.map(() => '?').join(',')}) ORDER BY confidence DESC`)
        .all(...scopes) as LawRow[]
    ).map(this.toLaw);
  }

  /** Every law across all scopes (for the read-only Memory panel). */
  listAll(): Law[] {
    return (this.db.query('SELECT * FROM graph_law ORDER BY scope, confidence DESC').all() as LawRow[]).map(this.toLaw);
  }

  /** Replace this scope's contradiction flags: clear them all, then mark the given laws with the
   *  fact text that contradicts each. One call captures the full result of a /check-memory pass. */
  setContradictions(scope: string, byLawId: Map<string, string>): void {
    const tx = this.db.transaction(() => {
      this.db.query('UPDATE graph_law SET contradicted_by = NULL WHERE scope = $s').run({ $s: scope });
      for (const [lawId, text] of byLawId) {
        this.db.query('UPDATE graph_law SET contradicted_by = $t WHERE id = $id').run({ $t: text, $id: lawId });
      }
    });
    tx();
  }

  private toLaw = (r: LawRow): Law => ({
    id: r.id,
    scope: r.scope,
    statement: r.statement,
    support: z.array(z.string()).parse(JSON.parse(r.support)),
    confidence: r.confidence,
    updatedAt: r.updated_at,
    contradictedBy: r.contradicted_by ?? null
  });

  close(): void {
    this.db.close();
  }
}
