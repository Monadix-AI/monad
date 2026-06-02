// Incremental-consolidation bookkeeping: a per-(layer, scope) fingerprint of the inputs that produced
// the current result. /consolidate skips a scope whose inputs are byte-identical to last time —
// turning the marginal cost of a re-run from "every scope" into "only the scopes that changed".
// L2 is already incremental (per-session watermark); this covers L1 (fact dedup) and L3 (law derive).

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

const DDL = `
CREATE TABLE IF NOT EXISTS consolidation_state (
  key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** Order-independent fingerprint of a set of ids — same set ⇒ same hash, regardless of order. */
export function fingerprint(ids: string[]): string {
  return createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
}

export class ConsolidationState {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;'); // shares memory.sqlite with graph + law stores
    this.db.exec(DDL);
  }

  get(key: string): string | null {
    const row = this.db.query('SELECT fingerprint FROM consolidation_state WHERE key = $k').get({ $k: key }) as {
      fingerprint: string;
    } | null;
    return row?.fingerprint ?? null;
  }

  set(key: string, fp: string): void {
    this.db
      .query(
        `INSERT INTO consolidation_state (key, fingerprint, updated_at) VALUES ($k, $f, $n)
         ON CONFLICT(key) DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`
      )
      .run({ $k: key, $f: fp, $n: Date.now() });
  }

  close(): void {
    this.db.close();
  }
}
