import { expect, test } from 'bun:test';

import { createManagedProjectOutputHandler } from '#/handlers/session/handlers/managed-project-output-handler.ts';

const output = {
  sessionId: 'ses_out00000001',
  meshSessionId: 'mesh_out00000001',
  agentName: 'codex',
  text: 'streamed answer'
} as Parameters<ReturnType<typeof createManagedProjectOutputHandler>>[0];

test('provider output completes against the runtime owner, keyed by projectMemberId not the alias', async () => {
  const completed: Array<{ projectMemberId: string; text: string }> = [];
  const warnings: unknown[] = [];
  const handler = createManagedProjectOutputHandler({
    getMeshSession: () => ({ projectMemberId: 'pmem_codex' }),
    completeProviderMessage: (input) => {
      completed.push({ projectMemberId: input.projectMemberId, text: input.text });
      return Promise.resolve({ id: 'msg_x' });
    },
    warn: (fields) => warnings.push(fields)
  });

  // agentName ('codex') differs from the owner ('pmem_codex'): completion keys on the canonical owner.
  await handler(output);

  expect({ completed, warnings }).toEqual({
    completed: [{ projectMemberId: 'pmem_codex', text: 'streamed answer' }],
    warnings: []
  });
});

test('provider output for a runtime with no owner completes nothing and surfaces it', async () => {
  const completed: unknown[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  const handler = createManagedProjectOutputHandler({
    getMeshSession: () => ({ projectMemberId: null }),
    completeProviderMessage: (input) => {
      completed.push(input);
      return Promise.resolve({});
    },
    warn: (fields) => warnings.push(fields)
  });

  await handler(output);

  // Fail closed: never fall back to the alias — complete nothing, and emit one observable warning.
  expect({ completed, warnings }).toEqual({
    completed: [],
    warnings: [
      { event: 'managed_mesh.provider_output_unowned_runtime', meshSessionId: 'mesh_out00000001', agentName: 'codex' }
    ]
  });
});

test('provider output for a missing runtime row also fails closed with no completion', async () => {
  const completed: unknown[] = [];
  const handler = createManagedProjectOutputHandler({
    getMeshSession: () => null,
    completeProviderMessage: (input) => {
      completed.push(input);
      return Promise.resolve({});
    },
    warn: () => {}
  });

  await handler(output);

  expect(completed).toEqual([]);
});
