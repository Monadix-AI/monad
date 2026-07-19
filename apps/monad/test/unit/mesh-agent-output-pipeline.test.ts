import type { LiveMeshSession } from '#/services/mesh-agent/host/host-types.ts';
import type { MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';

import { expect, test } from 'bun:test';

import {
  MeshAgentOutputPipeline,
  type MeshAgentOutputPipelineContext
} from '#/services/mesh-agent/host/output-pipeline.ts';

test('structured provider identity updates both the live session and persisted session ref', () => {
  const updated: Array<{ id: string; providerSessionRef: string }> = [];
  const live = {
    id: 'mesh_output000000',
    agentName: 'codex',
    providerSessionRef: undefined,
    pendingApprovals: new Map()
  } as unknown as LiveMeshSession;
  const pipeline = new MeshAgentOutputPipeline({
    live: new Map([[live.id, live]]),
    store: {
      updateMeshSessionRef: (id: string, providerSessionRef: string) => updated.push({ id, providerSessionRef })
    },
    events: {},
    stop: () => {},
    getManagedProjectOutputHandler: () => null,
    log: {}
  } as unknown as MeshAgentOutputPipelineContext);

  pipeline.structuredEvent('ses_output000000', live.id, { provider: 'codex' } as MeshAgentProviderAdapter, {
    type: 'session_ref',
    payload: { providerSessionRef: 'thread-1' }
  });

  expect({ liveRef: live.providerSessionRef, updated }).toEqual({
    liveRef: 'thread-1',
    updated: [{ id: live.id, providerSessionRef: 'thread-1' }]
  });
});
