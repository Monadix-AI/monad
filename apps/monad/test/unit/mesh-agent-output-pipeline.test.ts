import type { LiveMeshSession, MeshAgentApprovalMode } from '#/services/mesh-agent/host/host-types.ts';
import type { MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';

import { expect, test } from 'bun:test';

import {
  MeshAgentOutputPipeline,
  type MeshAgentOutputPipelineContext
} from '#/services/mesh-agent/host/output-pipeline.ts';

function createApprovalHarness(args: {
  approvalMode: MeshAgentApprovalMode;
  provider?: string;
  resolveApproval?: (decision: { requestId: string; allow: boolean; reason?: string }) => Promise<void>;
}) {
  const resolutions: Array<{ requestId: string; allow: boolean; reason?: string }> = [];
  const emitted: Array<{ sessionId: string; type: string; payload: unknown }> = [];
  const stopped: string[] = [];
  const outputs: unknown[] = [];
  const live = {
    id: 'mesh_approval0000',
    transcriptTargetId: 'ses_approval0000',
    agentName: 'reviewer',
    provider: args.provider ?? 'codex',
    runtimeRole: 'managed-project-agent',
    approvalMode: args.approvalMode,
    pendingApprovals: new Map(),
    sessionEventRuntime: {
      resolveApproval: async (decision: { requestId: string; allow: boolean; reason?: string }) => {
        resolutions.push(decision);
        await args.resolveApproval?.(decision);
      }
    }
  } as unknown as LiveMeshSession;
  const pipeline = new MeshAgentOutputPipeline({
    live: new Map([[live.id, live]]),
    store: {
      getMeshSession: () => ({
        runtimeRole: 'managed-project-agent',
        agentName: live.agentName,
        lastVisibleSeq: 0
      }),
      hasUnconsumedMeshAgentInbox: () => true,
      meshAgentInboxCursor: () => ({ deliveredSeq: 1, visibleSeq: 1 }),
      markMeshAgentInboxConsumed: () => {}
    },
    events: {
      emit: (sessionId: string, type: string, payload: unknown) => emitted.push({ sessionId, type, payload })
    },
    stop: (id: string) => stopped.push(id),
    getManagedProjectOutputHandler: () => (output: unknown) => outputs.push(output),
    getManagedProjectLoopEventHandler: () => null,
    log: { debug: () => {} }
  } as unknown as MeshAgentOutputPipelineContext);
  const adapter = {
    provider: live.provider,
    label: live.provider === 'openclaw' ? 'OpenClaw' : live.provider
  } as MeshAgentProviderAdapter;
  return { adapter, emitted, live, outputs, pipeline, resolutions, stopped };
}

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

test('managed output forwards provider-neutral loop events without creating UI state', () => {
  const forwarded: unknown[] = [];
  const live = {
    id: 'mesh_output000002',
    transcriptTargetId: 'ses_output000002',
    agentName: 'reviewer',
    runtimeRole: 'managed-project-agent',
    pendingApprovals: new Map()
  } as unknown as LiveMeshSession;
  const pipeline = new MeshAgentOutputPipeline({
    live: new Map([[live.id, live]]),
    store: {},
    events: {},
    stop: () => {},
    getManagedProjectOutputHandler: () => null,
    getManagedProjectLoopEventHandler: () => (event: unknown) => forwarded.push(event),
    log: {}
  } as unknown as MeshAgentOutputPipelineContext);
  const adapter = { provider: 'codex' } as MeshAgentProviderAdapter;

  pipeline.structuredEvent(
    live.transcriptTargetId,
    live.id,
    adapter,
    { type: 'tool_call', payload: { callId: 'call_1', tool: 'read_file' } },
    'codex'
  );
  pipeline.structuredEvent(
    live.transcriptTargetId,
    live.id,
    adapter,
    { type: 'tool_result', payload: { callId: 'call_1', output: 'ok' } },
    'codex'
  );

  expect(forwarded).toEqual([
    {
      kind: 'output',
      sessionId: live.transcriptTargetId,
      meshSessionId: live.id,
      memberId: 'reviewer',
      event: { type: 'tool_call', payload: { callId: 'call_1', tool: 'read_file' } }
    },
    {
      kind: 'output',
      sessionId: live.transcriptTargetId,
      meshSessionId: live.id,
      memberId: 'reviewer',
      event: { type: 'tool_result', payload: { callId: 'call_1', output: 'ok' } }
    }
  ]);
});

test('autopilot resolves ordinary provider approvals without creating pending UI state', async () => {
  const harness = createApprovalHarness({ approvalMode: 'autopilot', provider: 'openclaw' });
  const event = {
    type: 'approval_requested' as const,
    payload: { requestId: 'approval-1', kind: 'exec', tool: 'shell', input: { command: 'pwd' } }
  };

  harness.pipeline.structuredEvent(
    harness.live.transcriptTargetId,
    harness.live.id,
    harness.adapter,
    event,
    'openclaw'
  );
  await Promise.resolve();

  expect({
    resolutions: harness.resolutions,
    pending: [...harness.live.pendingApprovals.entries()],
    emitted: harness.emitted,
    stopped: harness.stopped
  }).toEqual({
    resolutions: [
      {
        requestId: 'approval-1',
        allow: true,
        reason: 'managed project MeshAgent autopilot'
      }
    ],
    pending: [],
    emitted: [],
    stopped: []
  });
});

test('autopilot denies Monad host escape approvals while allowing ordinary Monad approvals', async () => {
  const harness = createApprovalHarness({ approvalMode: 'autopilot', provider: 'monad' });
  const requests = [
    { requestId: 'ordinary', kind: 'tool', tool: 'project_read', input: { path: 'README.md' } },
    {
      requestId: 'host-control',
      kind: 'tool',
      tool: 'computer_use',
      key: 'host-control',
      input: { action: 'click' }
    },
    {
      requestId: 'code-host',
      kind: 'tool',
      tool: 'code_execute',
      key: 'target:host',
      input: { code: 'return process.cwd()' }
    }
  ];

  for (const payload of requests) {
    harness.pipeline.structuredEvent(
      harness.live.transcriptTargetId,
      harness.live.id,
      harness.adapter,
      { type: 'approval_requested', payload },
      'monad'
    );
  }
  await Promise.resolve();

  expect({
    resolutions: harness.resolutions,
    pending: [...harness.live.pendingApprovals.entries()],
    emitted: harness.emitted
  }).toEqual({
    resolutions: [
      {
        requestId: 'ordinary',
        allow: true,
        reason: 'managed project MeshAgent autopilot'
      },
      {
        requestId: 'host-control',
        allow: false,
        reason: 'Monad autopilot blocks host escape'
      },
      {
        requestId: 'code-host',
        allow: false,
        reason: 'Monad autopilot blocks host escape'
      }
    ],
    pending: [],
    emitted: []
  });
});

test('delegated approvals create one pending UI request and do not resolve at the provider', () => {
  const harness = createApprovalHarness({ approvalMode: 'delegated' });
  const event = {
    type: 'approval_requested' as const,
    payload: { requestId: 'approval-2', kind: 'exec', tool: 'shell', input: { command: 'pwd' } }
  };

  harness.pipeline.structuredEvent(harness.live.transcriptTargetId, harness.live.id, harness.adapter, event, 'codex');
  harness.pipeline.structuredEvent(harness.live.transcriptTargetId, harness.live.id, harness.adapter, event, 'codex');

  expect({
    resolutions: harness.resolutions,
    pending: [...harness.live.pendingApprovals.entries()],
    emitted: harness.emitted
  }).toEqual({
    resolutions: [],
    pending: [['approval-2', event.payload]],
    emitted: [
      {
        sessionId: harness.live.transcriptTargetId,
        type: 'mesh.approval_requested',
        payload: {
          meshSessionId: harness.live.id,
          provider: 'codex',
          requestId: 'approval-2',
          text: 'exec',
          data: event.payload
        }
      }
    ]
  });
});

test('autopilot resolution failure surfaces a managed provider error and stops the runtime', async () => {
  const harness = createApprovalHarness({
    approvalMode: 'autopilot',
    provider: 'openclaw',
    resolveApproval: async () => {
      throw new Error('gateway unavailable');
    }
  });

  harness.pipeline.structuredEvent(
    harness.live.transcriptTargetId,
    harness.live.id,
    harness.adapter,
    {
      type: 'approval_requested',
      payload: { requestId: 'approval-3', kind: 'exec', tool: 'shell', input: { command: 'pwd' } }
    },
    'openclaw'
  );
  await Promise.resolve();
  await Promise.resolve();

  expect({ outputs: harness.outputs, stopped: harness.stopped }).toEqual({
    outputs: [
      {
        sessionId: harness.live.transcriptTargetId,
        meshSessionId: harness.live.id,
        agentName: harness.live.agentName,
        text: 'Failed to resolve OpenClaw autopilot approval: gateway unavailable',
        error: true,
        post: false
      }
    ],
    stopped: [harness.live.id]
  });
});
