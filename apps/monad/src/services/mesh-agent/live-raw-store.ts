import type { ObservationCursor } from '@monad/protocol';

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { formatObservationCursor, MESH_AGENT_OUTPUT_SNAPSHOT_MAX } from '@monad/protocol';

type LiveRawStream = 'stderr' | 'stdout';

type LiveRawFrame = {
  stream: LiveRawStream;
  payload: string;
  observedAt: string;
};

export type LiveRawRow = LiveRawFrame & { seq: number };

export function liveRawRowsOutput(rows: LiveRawRow[]): string {
  return rows.map((row) => row.payload).join('');
}

type LiveRawPageRequest = {
  after?: number;
  before?: number;
  limit: number;
  maxBytes?: number;
  sortDirection: 'asc' | 'desc';
};

type LiveRawPage = {
  rows: LiveRawRow[];
  nextBefore?: number;
};

type InsertResult = { lastInsertRowid: number | bigint };

function liveStoreName(sessionId: string, epoch: string): string {
  return `${encodeURIComponent(sessionId)}-${encodeURIComponent(epoch)}.sqlite`;
}

export class LiveRawStore {
  readonly path: string;
  readonly epoch: string;

  private closed = false;
  private readonly database: Database;
  private readonly insertStatement;
  private readonly oldestStatement;
  private readonly afterStatement;
  private readonly newestStatement;
  private readonly beforeStatement;

  private constructor(args: { directory: string; sessionId: string; epoch: string }) {
    mkdirSync(args.directory, { recursive: true });
    this.epoch = args.epoch;
    this.path = join(args.directory, liveStoreName(args.sessionId, args.epoch));
    this.database = new Database(this.path, { create: true, strict: true });
    this.database.run('PRAGMA journal_mode = WAL');
    this.database.run('PRAGMA synchronous = FULL');
    this.database.run('PRAGMA busy_timeout = 5000');
    this.database.run(`
      CREATE TABLE IF NOT EXISTS raw_frames (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL,
        payload TEXT NOT NULL,
        observed_at TEXT NOT NULL
      ) STRICT
    `);
    this.insertStatement = this.database.prepare<InsertResult, [LiveRawStream, string, string]>(
      'INSERT INTO raw_frames (stream, payload, observed_at) VALUES (?1, ?2, ?3)'
    );
    this.oldestStatement = this.database.prepare<LiveRawRow, [number]>(
      'SELECT seq, stream, payload, observed_at AS observedAt FROM raw_frames ORDER BY seq ASC LIMIT ?1'
    );
    this.afterStatement = this.database.prepare<LiveRawRow, [number, number]>(
      'SELECT seq, stream, payload, observed_at AS observedAt FROM raw_frames WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2'
    );
    this.newestStatement = this.database.prepare<LiveRawRow, [number]>(
      'SELECT seq, stream, payload, observed_at AS observedAt FROM raw_frames ORDER BY seq DESC LIMIT ?1'
    );
    this.beforeStatement = this.database.prepare<LiveRawRow, [number, number]>(
      'SELECT seq, stream, payload, observed_at AS observedAt FROM raw_frames WHERE seq < ?1 ORDER BY seq DESC LIMIT ?2'
    );
  }

  static open(args: { directory: string; sessionId: string; epoch: string }): LiveRawStore {
    return new LiveRawStore(args);
  }

  append(frame: LiveRawFrame): LiveRawRow {
    this.assertOpen();
    if (Buffer.byteLength(frame.payload) > MESH_AGENT_OUTPUT_SNAPSHOT_MAX) {
      throw new Error('raw frame exceeds storage byte limit');
    }
    const result = this.insertStatement.run(frame.stream, frame.payload, frame.observedAt);
    return { seq: Number(result.lastInsertRowid), ...frame };
  }

  page(request: LiveRawPageRequest): LiveRawPage {
    this.assertOpen();
    const limit = Math.max(1, Math.trunc(request.limit));
    const maxBytes = request.maxBytes === undefined ? Number.POSITIVE_INFINITY : Math.max(1, request.maxBytes);
    const queryLimit = limit + 1;
    if (request.sortDirection === 'asc') {
      const source =
        request.after === undefined
          ? this.oldestStatement.all(queryLimit)
          : this.afterStatement.all(request.after, queryLimit);
      return { rows: takeBoundedRows(source, limit, maxBytes).rows };
    }
    const source =
      request.before === undefined
        ? this.newestStatement.all(queryLimit)
        : this.beforeStatement.all(request.before, queryLimit);
    const bounded = takeBoundedRows(source, limit, maxBytes);
    const rows = bounded.rows.reverse();
    return {
      rows,
      ...(bounded.hasMore && rows[0] ? { nextBefore: rows[0].seq } : {})
    };
  }

  cursorBefore(seq: number): ObservationCursor {
    return formatObservationCursor({ kind: 'live', observationEpoch: this.epoch, seq });
  }

  async closeAndDelete(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.database.close();
    }
    await Promise.all([
      rm(this.path, { force: true }),
      rm(`${this.path}-wal`, { force: true }),
      rm(`${this.path}-shm`, { force: true })
    ]);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('live raw store is closed');
  }
}

function takeBoundedRows(
  source: Iterable<LiveRawRow>,
  limit: number,
  maxBytes: number
): {
  rows: LiveRawRow[];
  hasMore: boolean;
} {
  const rows: LiveRawRow[] = [];
  let bytes = 0;
  for (const row of source) {
    const rowBytes = Buffer.byteLength(row.payload);
    if (rowBytes > maxBytes) throw new Error('raw frame exceeds page byte limit');
    if (rows.length >= limit || bytes + rowBytes > maxBytes) {
      return { rows, hasMore: true };
    }
    rows.push(row);
    bytes += rowBytes;
  }
  return { rows, hasMore: false };
}

export async function cleanupStaleLiveRawStores(directory: string): Promise<{ deleted: number }> {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  const stale = entries.filter(
    (entry) =>
      entry.isFile() &&
      (entry.name.endsWith('.sqlite') || entry.name.endsWith('.sqlite-wal') || entry.name.endsWith('.sqlite-shm'))
  );
  await Promise.all(stale.map((entry) => rm(join(directory, entry.name), { force: true })));
  return { deleted: stale.length };
}
