import type { LiveMeshSession } from '#/services/mesh-agent/host/host-types.ts';
import type { MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';

import { expect, test } from 'bun:test';

import {
  MeshAgentOutputPipeline,
  type MeshAgentOutputPipelineContext
} from '#/services/mesh-agent/host/output-pipeline.ts';

test('final provider output stays inside the event-consumption completion barrier', async () => {
  let releaseProjection: (() => void) | undefined;
  const projection = new Promise<void>((resolve) => {
    releaseProjection = resolve;
  });
  const live = {
    id: 'mesh_output_settlement',
    transcriptTargetId: 'ses_output_settlement',
    agentName: 'reviewer',
    runtimeRole: 'managed-project-agent',
    pendingApprovals: new Map()
  } as unknown as LiveMeshSession;
  const projected: unknown[] = [];
  const pipeline = new MeshAgentOutputPipeline({
    live: new Map([[live.id, live]]),
    store: {
      getMeshSession: () => ({ runtimeRole: 'managed-project-agent', agentName: live.agentName }),
      hasUnconsumedMeshAgentInbox: () => true,
      meshAgentInboxCursor: () => ({ deliveredSeq: 1, visibleSeq: 1 }),
      markMeshAgentInboxConsumed: () => {}
    },
    events: {},
    stop: () => {},
    getManagedProjectOutputHandler: () => async (output: unknown) => {
      await projection;
      projected.push(output);
    },
    getManagedProjectLoopEventHandler: () => null,
    log: { debug: () => {} }
  } as unknown as MeshAgentOutputPipelineContext);

  let consumed = false;
  const consumption = pipeline
    .structuredEvent(
      live.transcriptTargetId,
      live.id,
      { provider: 'codex' } as MeshAgentProviderAdapter,
      { type: 'agent_message', payload: { text: 'done', final: true } },
      'codex'
    )
    .then(() => {
      consumed = true;
    });
  await Promise.resolve();
  expect({ consumed, projected }).toEqual({ consumed: false, projected: [] });

  releaseProjection?.();
  await consumption;
  expect({ consumed, projected }).toEqual({
    consumed: true,
    projected: [
      {
        sessionId: live.transcriptTargetId,
        meshSessionId: live.id,
        agentName: live.agentName,
        text: 'done',
        error: false,
        post: false
      }
    ]
  });
});
