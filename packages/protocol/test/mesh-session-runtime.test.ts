import type { MeshAgentTurnAttachment } from '../src/index.ts';

import { expect, test } from 'bun:test';

import {
  meshAgentPresetSchema,
  meshAgentRuntimeCapabilitiesSchema,
  meshAgentTurnInputSchema,
  meshAgentViewSchema,
  meshConnectionConditionSchema,
  meshExecutionActivitySchema,
  meshSessionLifecycleSchema,
  meshSessionViewSchema,
  NATIVE_AGENT_ATTACHMENTS_MAX,
  startMeshAgentRequestSchema
} from '../src/index.ts';

const attachment = {
  id: 'att_1234567890ab',
  path: '/workspace/report.md',
  name: 'report.md',
  mime: 'text/markdown',
  bytes: 42
} satisfies MeshAgentTurnAttachment;

test('session runtime schemas preserve the exact active idle contract', () => {
  expect(meshSessionLifecycleSchema.parse({ state: 'active' })).toEqual({ state: 'active' });
  expect(meshExecutionActivitySchema.parse({ state: 'idle', pid: null, queuedTurnCount: 0 })).toEqual({
    state: 'idle',
    pid: null,
    queuedTurnCount: 0
  });
});

test('session runtime schemas preserve terminal failure and reconnect detail', () => {
  expect(
    meshSessionLifecycleSchema.parse({
      state: 'terminal',
      termination: {
        kind: 'failed',
        at: '2026-07-19T00:00:00.000Z',
        exitCode: 2,
        error: { code: 'provider_protocol_error', message: 'invalid frame', retryable: false }
      }
    })
  ).toEqual({
    state: 'terminal',
    termination: {
      kind: 'failed',
      at: '2026-07-19T00:00:00.000Z',
      exitCode: 2,
      error: { code: 'provider_protocol_error', message: 'invalid frame', retryable: false }
    }
  });
  expect(
    meshConnectionConditionSchema.parse({
      state: 'reconnecting',
      attempt: 2,
      nextAttemptAt: '2026-07-19T00:00:01.000Z'
    })
  ).toEqual({ state: 'reconnecting', attempt: 2, nextAttemptAt: '2026-07-19T00:00:01.000Z' });
});

test('session runtime capabilities keep continuation concerns separate', () => {
  expect(
    meshAgentRuntimeCapabilitiesSchema.parse({
      input: true,
      steer: false,
      interrupt: true,
      approvalResolution: false,
      providerSessionContinuation: true,
      runtimeRestoration: false,
      sessionReopen: true
    })
  ).toEqual({
    input: true,
    steer: false,
    interrupt: true,
    approvalResolution: false,
    providerSessionContinuation: true,
    runtimeRestoration: false,
    sessionReopen: true
  });
});

test('turn input preserves bounded registered attachment references', () => {
  expect(meshAgentTurnInputSchema.parse({ text: 'Review this', attachments: [attachment] })).toEqual({
    text: 'Review this',
    attachments: [attachment]
  });
});

test('execution activity rejects impossible pid and queue combinations', () => {
  expect(meshExecutionActivitySchema.safeParse({ state: 'idle', pid: null, queuedTurnCount: 1 }).success).toBe(false);
  expect(meshExecutionActivitySchema.safeParse({ state: 'running', pid: null, queuedTurnCount: 0 }).success).toBe(
    false
  );
});

test('turn input rejects attachment overflow', () => {
  expect(
    meshAgentTurnInputSchema.safeParse({
      text: 'Review these',
      attachments: Array.from({ length: NATIVE_AGENT_ATTACHMENTS_MAX + 1 }, () => attachment)
    }).success
  ).toBe(false);
});

test('public MeshAgent configuration strips provider runtime topology', () => {
  expect(
    meshAgentViewSchema.parse({
      name: 'codex',
      provider: 'codex',
      command: 'codex',
      enabled: true,
      defaultLaunchMode: 'app-server',
      appServerTransport: 'ws'
    })
  ).toEqual({
    name: 'codex',
    provider: 'codex',
    command: 'codex',
    enabled: true,
    allowAutopilot: true,
    approvalOwnership: 'provider-owned'
  });
  expect(
    meshAgentPresetSchema.parse({
      id: 'codex',
      label: 'Codex',
      provider: 'codex',
      productIcon: 'codex',
      command: 'codex',
      args: [],
      defaultLaunchMode: 'app-server',
      supportedLaunchModes: ['app-server'],
      supportedAppServerTransports: ['ws'],
      installHint: 'Install Codex',
      installUrl: 'https://example.com',
      installed: true
    })
  ).toEqual({
    id: 'codex',
    label: 'Codex',
    provider: 'codex',
    productIcon: 'codex',
    command: 'codex',
    args: [],
    installHint: 'Install Codex',
    installUrl: 'https://example.com',
    installed: true
  });
});

test('public MeshAgent session contract exposes provider-neutral runtime state', () => {
  const capabilities = {
    input: true,
    steer: false,
    interrupt: true,
    approvalResolution: false,
    providerSessionContinuation: true,
    runtimeRestoration: true,
    sessionReopen: true
  };
  expect(
    meshSessionViewSchema.parse({
      id: 'mesh_1234567890ab',
      sessionId: 'ses_1234567890ab',
      agentName: 'codex',
      provider: 'codex',
      workingPath: '/workspace',
      lifecycle: { state: 'active' },
      activity: { state: 'idle', pid: null, queuedTurnCount: 0 },
      connection: { state: 'inactive' },
      capabilities,
      runtimeRole: 'interactive',
      startedAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z'
    })
  ).toEqual({
    id: 'mesh_1234567890ab',
    sessionId: 'ses_1234567890ab',
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/workspace',
    approvalOwnership: 'provider-owned',
    runtimeRole: 'interactive',
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    pendingApprovalCount: 0,
    lifecycle: { state: 'active' },
    activity: { state: 'idle', pid: null, queuedTurnCount: 0 },
    connection: { state: 'inactive' },
    capabilities,
    startedAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z'
  });
  expect(
    startMeshAgentRequestSchema.parse({
      transcriptTargetId: 'ses_1234567890ab',
      agentName: 'codex',
      workingPath: '/workspace',
      launchMode: 'app-server'
    })
  ).toEqual({ transcriptTargetId: 'ses_1234567890ab', agentName: 'codex', workingPath: '/workspace' });
});
