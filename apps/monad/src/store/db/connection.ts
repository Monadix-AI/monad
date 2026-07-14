import type { Database } from 'bun:sqlite';

export function configureSqliteConnection(sqlite: Database, path: string): void {
  if (path !== ':memory:') {
    const row = sqlite.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string } | null;
    if (row?.journal_mode.toLowerCase() !== 'wal') {
      throw new Error(`SQLite WAL mode was not enabled for ${path}: ${row?.journal_mode ?? 'no result'}`);
    }
  }

  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA synchronous = NORMAL');
}
