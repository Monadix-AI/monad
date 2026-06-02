import type { Logger } from '@monad/logger';
import type { MeshAgentProvider } from '@monad/protocol';

import { randomUUID } from 'node:crypto';
import { mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJsonlFrames } from '@monad/atoms/agent-adapters/observation-fixture';

const MESH_FIXTURE_CAPTURE_MAX_RECORDS = 500;
const CAPTURE_FILE_PATTERN = /^(.+)-mesh_[0-9A-Za-z]{12}-oep_[0-9A-Za-z]{12}\.jsonl$/;
const CAPTURE_TEMP_PATTERN =
  /^\.(.+\.jsonl)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

export function isMeshFixtureCaptureFileName(name: string): boolean {
  const encodedProvider = CAPTURE_FILE_PATTERN.exec(name)?.[1];
  if (!encodedProvider) return false;
  try {
    const provider = decodeURIComponent(encodedProvider);
    return provider.length > 0 && encodeURIComponent(provider) === encodedProvider;
  } catch {
    return false;
  }
}

export function isMeshFixtureCaptureTempFileName(name: string): boolean {
  const match = CAPTURE_TEMP_PATTERN.exec(name);
  return match?.[1] !== undefined && isMeshFixtureCaptureFileName(match[1]);
}

export interface MeshFixtureTapFileSystem {
  mkdir: typeof mkdir;
  open: typeof open;
  rename: typeof rename;
}

const defaultFileSystem: MeshFixtureTapFileSystem = { mkdir, open, rename };

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
  private readonly fileSystem: MeshFixtureTapFileSystem;

  constructor(
    private readonly directory: string,
    private readonly log: Logger,
    private readonly maxRecords: number = MESH_FIXTURE_CAPTURE_MAX_RECORDS,
    fileSystem: Partial<MeshFixtureTapFileSystem> = {}
  ) {
    this.fileSystem = { ...defaultFileSystem, ...fileSystem };
  }

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

    const name = `${encodeURIComponent(capture.provider)}-${encodeURIComponent(meshSessionId)}-${encodeURIComponent(observationEpoch)}.jsonl`;
    const path = join(this.directory, name);
    const tempPath = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await this.fileSystem.mkdir(this.directory, { recursive: true });
      handle = await this.fileSystem.open(tempPath, 'wx', 0o600);
      await handle.writeFile(`${capture.frames.map((data) => JSON.stringify(data)).join('\n')}\n`, 'utf8');
      await handle.close();
      handle = undefined;
      await this.fileSystem.rename(tempPath, path);
      this.log.info(
        {
          event: 'mesh.fixture_capture_written',
          meshSessionId,
          provider: capture.provider,
          records: capture.frames.length,
          basename: name
        },
        'mesh fixture capture written (unredacted, developer mode)'
      );
    } catch (err) {
      await handle?.close().catch(() => undefined);
      this.log.debug(
        {
          event: 'mesh.fixture_capture_error',
          meshSessionId,
          provider: capture.provider,
          err: err instanceof Error ? { name: err.name } : { name: 'UnknownError' }
        },
        'mesh fixture capture failed'
      );
    }
  }
}
