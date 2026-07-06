// Task queue rows: insert + optimistic-concurrency state transitions. Split out of index.ts —
// every function takes the raw bun:sqlite handle (or the drizzle db for the typed insert).

import type { Database } from 'bun:sqlite';
import type { Task, TaskState } from '@monad/protocol';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { tasks } from './schema.ts';

export function insertTask(db: BunSQLiteDatabase<Record<string, never>>, t: Task): void {
  db.insert(tasks)
    .values({
      ...t,
      dependsOn: JSON.stringify(t.dependsOn),
      result: t.result !== undefined ? JSON.stringify(t.result) : null,
      error: t.error !== undefined ? JSON.stringify(t.error) : null
    })
    .run();
}

/** Optimistic-concurrency CAS on `version`; returns true iff the row was updated. */
export function casTaskState(
  sqlite: Database,
  id: string,
  expectedVersion: number,
  next: TaskState,
  updatedAt: string
): boolean {
  const result = sqlite
    .query('UPDATE tasks SET state=$next, version=version+1, updated_at=$updatedAt WHERE id=$id AND version=$expected')
    .run({ $next: next, $updatedAt: updatedAt, $id: id, $expected: expectedVersion });
  return result.changes === 1;
}
