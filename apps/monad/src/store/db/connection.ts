import type { Database } from 'bun:sqlite';

export function configureSqliteConnection(sqlite: Database, path: string): void {
  if (path !== ':memory:') {
    const row = sqlite.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: unknown } | null;
    const journalMode = row?.journal_mode;
    if (typeof journalMode !== 'string' || journalMode.toLowerCase() !== 'wal') {
      throw new Error(`SQLite WAL mode was not enabled for ${path}: ${String(journalMode ?? 'no result')}`);
    }
  }

  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA synchronous = NORMAL');
}
