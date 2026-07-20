import type { Logger } from '@monad/logger';
import type { MeshAgentProvider } from '@monad/protocol';

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJsonlFrames } from '@monad/atoms/agent-adapters/observation-fixture';

const MESH_FIXTURE_CAPTURE_MAX_RECORDS = 500;

export interface MeshFixtureTapFrame {
  provider: MeshAgentProvider;
  meshSessionId: string;
  observationEpoch: string;
  stream: 'stdout' | 'stderr';
  payload: string;
  observedAt: string;
}

interface Capture {
  provider: MeshAgentProvider;
  frames: unknown[];
  pending: string;
  written: boolean;
}

/**
 * Developer-mode capture of live provider records, written as unredacted provider-native JSONL.
 * Redaction happens when a capture is promoted into a committed fixture (`scripts/mesh-fixture.ts`),
 * not here.
 *
 * A written capture therefore contains real paths, real prompts, and any secret the provider echoed:
 * it is developer-machine diagnostic output, mode 0600, and never produced outside developer mode.
 *
 * Buffers per epoch because `captureRaw` delivers byte packets, not whole records: a provider frame
 * can be split across two packets, so a fixture built on packet boundaries would contain unparseable
 * half-records. Only complete newline-terminated frames become fixture records.
 */
export class MeshFixtureTap {
  private readonly captures = new Map<string, Capture>();

  constructor(
    private readonly directory: string,
    private readonly log: Logger,
    private readonly maxRecords: number = MESH_FIXTURE_CAPTURE_MAX_RECORDS
  ) {}

  record(frame: MeshFixtureTapFrame): void {
    if (frame.stream !== 'stdout') return;
    const key = `${frame.meshSessionId}:${frame.observationEpoch}`;
    let capture = this.captures.get(key);
    if (!capture) {
      capture = { provider: frame.provider, frames: [], pending: '', written: false };
      this.captures.set(key, capture);
    }
    if (capture.frames.length >= this.maxRecords) return;

    const combined = capture.pending + frame.payload;
    const lastBreak = combined.lastIndexOf('\n');
    if (lastBreak < 0) {
      capture.pending = combined;
      return;
    }
    capture.pending = combined.slice(lastBreak + 1);
    for (const data of parseJsonlFrames(combined.slice(0, lastBreak))) {
      if (capture.frames.length >= this.maxRecords) break;
      capture.frames.push(data);
    }
  }

  async flush(meshSessionId: string, observationEpoch: string): Promise<void> {
    const key = `${meshSessionId}:${observationEpoch}`;
    const capture = this.captures.get(key);
    this.captures.delete(key);
    if (!capture || capture.written || capture.frames.length === 0) return;
    capture.written = true;

    const name = `${capture.provider}-${encodeURIComponent(meshSessionId)}-${encodeURIComponent(observationEpoch)}.jsonl`;
    const path = join(this.directory, name);
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(path, `${capture.frames.map((data) => JSON.stringify(data)).join('\n')}\n`, 'utf8');
      await chmod(path, 0o600);
      this.log.info(
        {
          event: 'mesh.fixture_capture_written',
          meshSessionId,
          provider: capture.provider,
          records: capture.frames.length,
          path
        },
        'mesh fixture capture written (unredacted, developer mode)'
      );
    } catch (err) {
      this.log.debug(
        {
          event: 'mesh.fixture_capture_error',
          meshSessionId,
          provider: capture.provider,
          err: err instanceof Error ? { message: err.message } : String(err)
        },
        'mesh fixture capture failed'
      );
    }
  }
}
