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

  pipeline.structuredEvent(
    'ses_output000000',
    live.id,
    { provider: 'codex' } as MeshAgentProviderAdapter,
    {
      type: 'session_ref',
      payload: { providerSessionRef: 'thread-1' }
    },
    'codex'
  );

  expect({ liveRef: live.providerSessionRef, updated }).toEqual({
    liveRef: 'thread-1',
    updated: [{ id: live.id, providerSessionRef: 'thread-1' }]
  });
});

test('connection required preserves the configured agent name for authentication', () => {
  const emitted: Array<{ sessionId: string; type: string; payload: unknown }> = [];
  const stopped: string[] = [];
  const live = {
    id: 'mesh_output000001',
    agentName: 'pmem_claude-code_opus',
    pendingApprovals: new Map()
  } as unknown as LiveMeshSession;
  const pipeline = new MeshAgentOutputPipeline({
    live: new Map([[live.id, live]]),
    store: {},
    events: {
      emit: (sessionId: string, type: string, payload: unknown) => emitted.push({ sessionId, type, payload })
    },
    stop: (id: string) => stopped.push(id),
    getManagedProjectOutputHandler: () => null,
    log: {}
  } as unknown as MeshAgentOutputPipelineContext);

  pipeline.structuredEvent(
    'ses_output000001',
    live.id,
    { provider: 'claude-code' } as MeshAgentProviderAdapter,
    {
      type: 'connection_required',
      payload: { code: 'authentication_failed', reason: 'Claude Code session is not signed in' }
    },
    'claude-code'
  );

  expect({ emitted, stopped }).toEqual({
    emitted: [
      {
        sessionId: 'ses_output000001',
        type: 'mesh.connection_required',
        payload: {
          meshSessionId: live.id,
          agentName: 'pmem_claude-code_opus',
          authAgentName: 'claude-code',
          provider: 'claude-code',
          code: 'authentication_failed',
          reason: 'Claude Code session is not signed in',
          reconnectIn: 'studio'
        }
      }
    ],
    stopped: [live.id]
  });
});
