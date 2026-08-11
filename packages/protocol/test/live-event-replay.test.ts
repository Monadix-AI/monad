import { expect, test } from 'bun:test';

import {
  daemonHttpContract,
  listLiveEventReplayCapturesResponseSchema,
  liveEventReplayFramePageSchema
} from '../src/index.ts';

test('developer replay contracts parse capture inventory and frame pagination exactly', () => {
  const captures = listLiveEventReplayCapturesResponseSchema.parse({
    captures: [
      {
        projectId: 'prj_100000000001',
        projectName: 'Observation fixes',
        sessionId: 'ses_100000000001',
        sessionTitle: 'Claude live thinking',
        projectMemberId: 'pmem_100000000001',
        memberName: 'Claude',
        meshSessionId: 'mesh_100000000001',
        provider: 'claude-code',
        observationEpoch: 'oep_100000000001',
        startedAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:01.000Z',
        frames: 2,
        bytes: 128
      }
    ]
  });
  const query = daemonHttpContract.developerSettings.getLiveEventFrames.query.parse({ offset: '20', limit: '50' });
  const page = liveEventReplayFramePageSchema.parse({
    frames: [{ seq: 21, stream: 'stdout', payload: '{"type":"message"}\n', observedAt: '2026-08-11T00:00:01.000Z' }],
    total: 70,
    offset: 20,
    limit: 50
  });

  expect({ captures, query, page }).toEqual({
    captures: {
      captures: [
        {
          projectId: 'prj_100000000001',
          projectName: 'Observation fixes',
          sessionId: 'ses_100000000001',
          sessionTitle: 'Claude live thinking',
          projectMemberId: 'pmem_100000000001',
          memberName: 'Claude',
          meshSessionId: 'mesh_100000000001',
          provider: 'claude-code',
          observationEpoch: 'oep_100000000001',
          startedAt: '2026-08-11T00:00:00.000Z',
          updatedAt: '2026-08-11T00:00:01.000Z',
          frames: 2,
          bytes: 128
        }
      ]
    },
    query: { offset: 20, limit: 50 },
    page: {
      frames: [{ seq: 21, stream: 'stdout', payload: '{"type":"message"}\n', observedAt: '2026-08-11T00:00:01.000Z' }],
      total: 70,
      offset: 20,
      limit: 50
    }
  });
});
