import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@monad/logger';

import { MeshLiveEventLog } from '#/services/mesh-agent/live-event-log.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MeshLiveEventLog', () => {
  test('persists exact packet boundaries under project, session, member, and native session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'monad-live-event-log-'));
    roots.push(root);
    const log = new MeshLiveEventLog(root, createLogger('live-event-log-test'));
    const base = {
      projectId: 'prj_100000000001' as const,
      sessionId: 'ses_100000000001' as const,
      projectMemberId: 'pmem_100000000001' as const,
      memberName: 'Codex',
      meshSessionId: 'mesh_100000000001' as const,
      provider: 'codex',
      observationEpoch: 'oep_100000000001'
    };
    log.record({ ...base, stream: 'stdout', payload: '{"id":1', observedAt: '2026-08-11T01:00:00.000Z' });
    log.record({ ...base, stream: 'stdout', payload: '}\n', observedAt: '2026-08-11T01:00:00.010Z' });
    log.record({ ...base, stream: 'stderr', payload: 'warning', observedAt: '2026-08-11T01:00:00.020Z' });

    await log.close(base.meshSessionId, base.observationEpoch);
    const page = await log.page(base.meshSessionId, base.observationEpoch, { offset: 0, limit: 10 });
    const capturePath = join(
      root,
      base.projectId,
      base.sessionId,
      base.projectMemberId,
      base.meshSessionId,
      `${base.observationEpoch}.jsonl`
    );
    const info = await lstat(capturePath);

    expect({
      page,
      mode: info.mode & 0o777,
      lines: (await readFile(capturePath, 'utf8')).trim().split('\n').length
    }).toEqual({
      page: {
        frames: [
          { seq: 1, stream: 'stdout', payload: '{"id":1', observedAt: '2026-08-11T01:00:00.000Z' },
          { seq: 2, stream: 'stdout', payload: '}\n', observedAt: '2026-08-11T01:00:00.010Z' },
          { seq: 3, stream: 'stderr', payload: 'warning', observedAt: '2026-08-11T01:00:00.020Z' }
        ],
        total: 3,
        offset: 0,
        limit: 10
      },
      mode: 0o600,
      lines: 3
    });
  });

  test('lists capture metadata and pages the requested native session only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'monad-live-event-list-'));
    roots.push(root);
    const log = new MeshLiveEventLog(root, createLogger('live-event-list-test'));
    log.record({
      projectId: 'prj_100000000002',
      sessionId: 'ses_100000000002',
      projectMemberId: 'member/codex',
      memberName: 'Codex',
      meshSessionId: 'mesh_100000000002',
      provider: 'codex',
      observationEpoch: 'oep_100000000002',
      stream: 'stdout',
      payload: '{"type":"turn.started"}\n',
      observedAt: '2026-08-11T02:00:00.000Z'
    });

    const captures = await log.list();
    const page = await log.page('mesh_100000000002', 'oep_100000000002', { offset: 1, limit: 20 });

    expect({ captures, page }).toEqual({
      captures: [
        {
          projectId: 'prj_100000000002',
          sessionId: 'ses_100000000002',
          projectMemberId: 'member/codex',
          memberName: 'Codex',
          meshSessionId: 'mesh_100000000002',
          provider: 'codex',
          observationEpoch: 'oep_100000000002',
          startedAt: '2026-08-11T02:00:00.000Z',
          updatedAt: '2026-08-11T02:00:00.000Z',
          frames: 1,
          bytes: expect.any(Number)
        }
      ],
      page: { frames: [], total: 1, offset: 1, limit: 20 }
    });
  });
});
