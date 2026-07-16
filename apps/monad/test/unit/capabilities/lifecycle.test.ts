import type { MonadPaths } from '@monad/environment';
import type { Tool } from '#/capabilities/tools/types.ts';
import type { SandboxSetup } from '#/platform/sandbox/service.ts';

import { expect, test } from 'bun:test';

import { createCapabilitiesLifecycleModule, createCapabilitiesRuntime } from '#/capabilities/lifecycle.ts';
import { toolResult } from '#/capabilities/tools/types.ts';
import { RuntimeContext } from '#/runtime/context.ts';

const paths = { credentials: '/home/.monad/credentials' } as MonadPaths;

function filesystemTool(): Tool<{ path: string }> {
  return {
    name: 'file_read',
    description: 'Read a file',
    scopes: [{ resource: 'fs:read' }],
    run: async () => toolResult('ok')
  };
}

test('registers static tools behind sandbox and credential protections', async () => {
  const runtime = createCapabilitiesRuntime({
    paths,
    sandboxRoots: ['/workspace'],
    tools: [filesystemTool()]
  });
  const protectedTool = runtime.registry.toolList()[0] as Tool<{ path: string }>;

  const approvals = await Promise.all([
    protectedTool.needsApproval?.({ path: '/home/.monad/credentials/auth.json' }, {} as never),
    protectedTool.needsApproval?.({ path: '/workspace/readme.md' }, {} as never)
  ]);

  expect({ approvals, scopes: protectedTool.scopes }).toEqual({
    approvals: [true, false],
    scopes: [{ resource: 'fs:read', constraints: { roots: ['/workspace'] } }]
  });
});

test('creates capabilities after platform sandbox readiness', async () => {
  const setup = {
    effectiveSandboxMode: 'workspace',
    sandboxRoots: ['/workspace'],
    sessionSandbox: {} as SandboxSetup['sessionSandbox']
  } satisfies SandboxSetup;
  const expected = createCapabilitiesRuntime({ paths, sandboxRoots: setup.sandboxRoots, tools: [] });
  const calls: Array<string[] | undefined> = [];
  const context = new RuntimeContext();
  context.commit('platform.sandbox', setup);
  const module = createCapabilitiesLifecycleModule({ paths }, (options) => {
    calls.push(options.sandboxRoots);
    return expected;
  });

  const output = await module.start(context, new AbortController().signal);

  expect({ calls, criticality: module.criticality, id: module.id, output, requires: module.requires }).toEqual({
    calls: [['/workspace']],
    criticality: 'required',
    id: 'capabilities',
    output: expected,
    requires: ['platform.sandbox']
  });
});
