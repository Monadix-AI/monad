import type { Stats } from 'node:fs';
import type { Logger } from '@monad/logger';
import type {
  GetLiveEventReplayFramesQuery,
  LiveEventReplayCapture,
  LiveEventReplayFrame,
  LiveEventReplayFramePage,
  MeshAgentProvider,
  MeshSessionId,
  ProjectId,
  ProjectMemberId,
  SessionId
} from '@monad/protocol';

import { createReadStream } from 'node:fs';
import { appendFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import {
  liveEventReplayCaptureSchema,
  liveEventReplayFrameSchema,
  meshSessionIdSchema,
  projectIdSchema,
  projectMemberIdSchema,
  sessionIdSchema
} from '@monad/protocol';

const EPOCH_PATTERN = /^oep_[0-9A-Za-z]{12}$/;

interface LiveEventLogRecord extends LiveEventReplayFrame {
  projectId: ProjectId;
  sessionId: SessionId;
  projectMemberId: ProjectMemberId;
  memberName: string;
  meshSessionId: MeshSessionId;
  provider: MeshAgentProvider;
  observationEpoch: string;
}

export interface MeshLiveEventLogFrame {
  projectId: ProjectId;
  sessionId: SessionId;
  projectMemberId: ProjectMemberId;
  memberName: string;
  meshSessionId: MeshSessionId;
  provider: MeshAgentProvider;
  observationEpoch: string;
  stream: 'stdout' | 'stderr';
  payload: string;
  observedAt: string;
}

export class MeshLiveEventLog {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly nextSeq = new Map<string, number>();

  constructor(
    private readonly directory: string,
    private readonly log: Logger
  ) {}

  record(frame: MeshLiveEventLogFrame): void {
    const path = this.capturePath(frame);
    const seq = (this.nextSeq.get(path) ?? 0) + 1;
    this.nextSeq.set(path, seq);
    const record: LiveEventLogRecord = { ...frame, seq };
    const previous = this.tails.get(path) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      })
      .catch((error) => {
        this.log.debug(
          {
            event: 'mesh.live_event_log_error',
            meshSessionId: frame.meshSessionId,
            err: error instanceof Error ? { name: error.name } : { name: 'UnknownError' }
          },
          'native cli live event log append failed'
        );
      });
    this.tails.set(path, next);
  }

  async close(meshSessionId: string, observationEpoch: string): Promise<void> {
    const entries = this.matchingTails(meshSessionId, observationEpoch);
    await Promise.all(entries.map(([, tail]) => tail));
    for (const [path] of entries) {
      this.tails.delete(path);
      this.nextSeq.delete(path);
    }
  }

  async list(): Promise<LiveEventReplayCapture[]> {
    await Promise.all(this.tails.values());
    const paths = await this.captureFiles();
    const captures: LiveEventReplayCapture[] = [];
    for (const path of paths) {
      const capture = await this.inspectCapture(path);
      if (capture) captures.push(capture);
    }
    return captures.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async page(
    meshSessionId: MeshSessionId,
    observationEpoch: string,
    query: GetLiveEventReplayFramesQuery
  ): Promise<LiveEventReplayFramePage | undefined> {
    await Promise.all(this.matchingTails(meshSessionId, observationEpoch).map(([, tail]) => tail));
    const paths = (await this.captureFiles()).filter(
      (path) => basename(dirname(path)) === meshSessionId && basename(path) === `${observationEpoch}.jsonl`
    );
    const path = paths[0];
    if (!path) return undefined;
    const frames: LiveEventReplayFrame[] = [];
    let total = 0;
    for await (const record of this.records(path)) {
      if (record.meshSessionId !== meshSessionId || record.observationEpoch !== observationEpoch) continue;
      if (total >= query.offset && frames.length < query.limit) {
        const { seq, stream, payload, observedAt } = record;
        frames.push({ seq, stream, payload, observedAt });
      }
      total += 1;
    }
    return {
      frames,
      total,
      offset: query.offset,
      limit: query.limit
    };
  }

  private capturePath(frame: MeshLiveEventLogFrame): string {
    const components = [
      projectIdSchema.parse(frame.projectId),
      sessionIdSchema.parse(frame.sessionId),
      encodePathComponent(projectMemberIdSchema.parse(frame.projectMemberId)),
      meshSessionIdSchema.parse(frame.meshSessionId)
    ];
    if (!EPOCH_PATTERN.test(frame.observationEpoch)) throw new Error('Invalid observation epoch');
    const path = resolve(this.directory, ...components, `${frame.observationEpoch}.jsonl`);
    if (!this.isWithinRoot(path)) throw new Error('Live event log path escaped its root');
    return path;
  }

  private matchingTails(meshSessionId: string, observationEpoch: string): [string, Promise<void>][] {
    return [...this.tails].filter(([path]) => {
      const parts = path.split(sep);
      return parts.at(-2) === meshSessionId && basename(path) === `${observationEpoch}.jsonl`;
    });
  }

  private async captureFiles(): Promise<string[]> {
    const paths: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      let names: string[];
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return;
        names = await readdir(directory);
      } catch {
        return;
      }
      await Promise.all(
        names.map(async (name) => {
          const path = join(directory, name);
          let stat: Stats;
          try {
            stat = await lstat(path);
          } catch {
            return;
          }
          if (stat.isSymbolicLink()) return;
          if (depth < 4 && stat.isDirectory()) return visit(path, depth + 1);
          if (
            depth === 4 &&
            stat.isFile() &&
            EPOCH_PATTERN.test(name.slice(0, -'.jsonl'.length)) &&
            name.endsWith('.jsonl')
          ) {
            paths.push(path);
          }
        })
      );
    };
    await visit(this.directory, 0);
    return paths;
  }

  private async inspectCapture(path: string): Promise<LiveEventReplayCapture | undefined> {
    try {
      const stat = await lstat(path);
      let first: LiveEventLogRecord | undefined;
      let last: LiveEventLogRecord | undefined;
      let frames = 0;
      for await (const record of this.records(path)) {
        first ??= record;
        last = record;
        frames += 1;
      }
      if (!first || !last) return undefined;
      return liveEventReplayCaptureSchema.parse({
        projectId: first.projectId,
        sessionId: first.sessionId,
        projectMemberId: first.projectMemberId,
        memberName: first.memberName,
        meshSessionId: first.meshSessionId,
        provider: first.provider,
        observationEpoch: first.observationEpoch,
        startedAt: first.observedAt,
        updatedAt: last.observedAt,
        frames,
        bytes: stat.size
      });
    } catch {
      return undefined;
    }
  }

  private async *records(path: string): AsyncGenerator<LiveEventLogRecord> {
    const input = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const line of lines) {
        const record = this.parseRecord(line);
        if (record) yield record;
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }

  private parseRecord(line: string): LiveEventLogRecord | undefined {
    if (!line) return undefined;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const frame = liveEventReplayFrameSchema.parse({
        seq: value.seq,
        stream: value.stream,
        payload: value.payload,
        observedAt: value.observedAt
      });
      return {
        ...frame,
        projectId: projectIdSchema.parse(value.projectId),
        sessionId: sessionIdSchema.parse(value.sessionId),
        projectMemberId: projectMemberIdSchema.parse(value.projectMemberId),
        memberName:
          typeof value.memberName === 'string' && value.memberName ? value.memberName : String(value.projectMemberId),
        meshSessionId: meshSessionIdSchema.parse(value.meshSessionId),
        provider: typeof value.provider === 'string' && value.provider ? value.provider : 'unknown',
        observationEpoch:
          typeof value.observationEpoch === 'string' && EPOCH_PATTERN.test(value.observationEpoch)
            ? value.observationEpoch
            : (() => {
                throw new Error('Invalid observation epoch');
              })()
      };
    } catch {
      return undefined;
    }
  }

  private isWithinRoot(path: string): boolean {
    const rel = relative(resolve(this.directory), path);
    return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
  }
}

function encodePathComponent(value: string): string {
  return encodeURIComponent(value).replaceAll('.', '%2E');
}
