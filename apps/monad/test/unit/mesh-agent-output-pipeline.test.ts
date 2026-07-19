import type { LiveMeshSession } from '#/services/mesh-agent/host/host-types.ts';
import type { MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';

import { expect, test } from 'bun:test';

import {
  MeshAgentOutputPipeline,
  type MeshAgentOutputPipelineContext
} from '#/services/mesh-agent/host/output-pipeline.ts';

const adapter = {
  provider: 'codex',
  events: { projectLive: () => ({ events: [] }) },
  parseOutput: () => [],
  stop: () => {},
  resolveApproval: () => {},
  resize: () => {},
  sendInput: () => {},
  start: () => {}
} as unknown as MeshAgentProviderAdapter;

function liveWithStore(append: (frame: { stream: string; payload: string; observedAt: string }) => unknown) {
  return {
    id: 'mesh_output',
    transcriptTargetId: 'ses_output',
    agentName: 'codex',
    provider: 'codex',
    runtimeRole: 'interactive',
    adapter,
    outputSeq: 0,
    liveRawStore: { append },
    pendingApprovals: new Map(),
    pendingEventPages: new Map(),
    pendingRequests: new Map()
  } as unknown as LiveMeshSession;
}

function pipelineFor(live: LiveMeshSession, order: string[]) {
  const context = {
    live: new Map([[live.id, live]]),
    store: {},
    events: { publish: () => order.push('event') },
    observation: { publish: () => order.push('observation') },
    stop: () => order.push('stop'),
    getManagedProjectOutputHandler: () => null,
    log: { error: () => order.push('log-error') },
    armIdleSuspend: () => order.push('idle')
  } as unknown as MeshAgentOutputPipelineContext;
  return new MeshAgentOutputPipeline(context);
}

test('output commits the exact frame before any observable publication', () => {
  const order: string[] = [];
  const live = liveWithStore((frame) => {
    order.push('commit');
    expect(frame).toMatchObject({ stream: 'app-server', payload: '{"method":"turn/started"}' });
    return { seq: 1, ...frame };
  });
  const pipeline = pipelineFor(live, order);

  pipeline.output('ses_output', live.id, '{"method":"turn/started"}', 'app-server', adapter);

  expect(order).toEqual(['commit', 'observation', 'idle']);
  expect(live.outputSeq).toBe(1);
});

test('a live-store write failure stops the runtime without publishing the frame', () => {
  const order: string[] = [];
  const live = liveWithStore(() => {
    order.push('commit');
    throw new Error('disk full');
  });
  const pipeline = pipelineFor(live, order);

  expect(() => pipeline.output('ses_output', live.id, 'lost', 'stdout', adapter)).toThrow('disk full');
  expect(order).toEqual(['commit', 'log-error', 'stop']);
  expect(live.outputSeq).toBe(0);
});
