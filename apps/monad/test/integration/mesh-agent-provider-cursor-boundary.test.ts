import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentProviderAdapter, PerTurnProviderDriver } from '@monad/sdk-atom';
import type { LiveMeshSession } from '#/services/mesh-agent/host/host-types.ts';

import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { EventBus } from '#/services/event-bus.ts';
import { MeshAgentHost } from '#/services/mesh-agent/host/index.ts';
import { registerAgentAdapterImpl, unregisterAgentAdapterImpl } from '#/services/mesh-agent/index.ts';
import { createStore } from '#/store/db/index.ts';

const builtinAdapter = builtinAgentAdapters[0];
if (!builtinAdapter) throw new Error('built-in MeshAgent adapter is required');
const events = builtinAdapter.events;

function driver(): PerTurnProviderDriver {
  return {
    processModel: 'per-turn',
    controls: { approvalResolution: false, steer: false, interrupt: false },
    async openSession() {
      return {
        capabilities: {
          input: true,
          steer: false,
          interrupt: false,
          approvalResolution: false,
          providerSessionContinuation: true,
          runtimeRestoration: true,
          sessionReopen: true
        }
      };
    },
    async attachTurnChannel() {},
    async accept() {},
    async completeTurn() {},
    async dispose() {}
  };
}

test('a resumed provider with offset cursors pages from live events into full history', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monad-provider-cursor-boundary-')));
  const provider = `provider-cursor-${crypto.randomUUID()}`;
  const pageRequests: unknown[] = [];
  const adapter: MeshAgentProviderAdapter = {
    deleteSession: async () => {},
    provider,
    icon: { title: 'Provider Cursor Test', path: 'M4 4h16v16H4z' },
    productIcon: 'codex',
    label: 'Provider Cursor Test',
    executionCapabilities: { autopilot: false, fastMode: false },
    managedRuntime: { usesManagedMcpBridge: true },
    events: {
      ...events,
      readPage: async (_context, request) => {
        pageRequests.push(request);
        if (request.view === 'raw') {
          return { state: 'available', view: 'raw', records: [], coverage: 'settled' };
        }
        if (request.before === 'line:1') {
          return {
            state: 'available',
            view: 'convenience',
            events: [
              {
                id: 'history-first',
                role: 'system',
                text: 'queue operation',
                source: 'unknown',
                provenance: { rawEvents: [] }
              }
            ]
          };
        }
        return {
          state: 'available',
          view: 'convenience',
          events: [
            {
              id: 'history-latest',
              role: 'agent',
              text: 'latest settled provider event',
              source: 'claude-code-sdk',
              provenance: { rawEvents: [] }
            }
          ],
          nextCursor: '521'
        };
      }
    },
    observation: builtinAdapter.observation,
    detect: () => ({
      id: provider,
      provider,
      productIcon: 'codex',
      label: 'Provider Cursor Test',
      command: process.execPath,
      args: ['-e', ''],
      installHint: 'test provider',
      installUrl: 'https://example.com/provider',
      installed: true
    }),
    listSupportedModels: () => [],
    modelOptions: () => ({ resolve: async () => [{ value: 'default' }] }),
    resolveCommand: (command) => command,
    buildAuthLaunch: (configured) => ({ argv: [configured.command], cwd: root }),
    buildAuthStatusLaunch: (configured) => ({ argv: [configured.command], cwd: root }),
    authStatus: (configured) => ({ launch: { argv: [configured.command], cwd: root }, parse: () => 'authenticated' }),
    parseAuthStatus: () => 'authenticated',
    createSessionRuntime: () => ({
      plan: {
        processModel: 'per-turn',
        buildTurnLaunch: () => ({ args: ['-e', ''], cwd: root }),
        encodeTurnInput: () => ({ delivery: 'stdin', bytes: new Uint8Array() }),
        startup: { timeoutMs: 1_000 },
        continuation: { strategy: 'provider-session-ref' }
      },
      driver: driver()
    })
  };
  const configuredAgent: MeshAgentView = {
    name: provider,
    provider,
    productIcon: 'codex',
    command: process.execPath,
    args: ['-e', ''],
    enabled: true,
    allowAutopilot: false,
    approvalOwnership: 'provider-owned'
  };
  registerAgentAdapterImpl(adapter);
  const store = createStore();
  const host = new MeshAgentHost({
    store,
    bus: new EventBus(),
    agents: async () => [configuredAgent],
    monadHome: root,
    meshAgentLiveStoreDirectory: join(root, 'live')
  });
  try {
    const resumed = await host.start({
      transcriptTargetId: 'ses_resume000000',
      agentName: provider,
      workingPath: root,
      runtimeRole: 'interactive',
      providerSessionRef: 'provider-offset-session'
    });
    const live = (host as unknown as { live: Map<string, LiveMeshSession> }).live.get(resumed.id);
    if (!live) throw new Error('resumed live session is required');

    const liveBoundaryPage = await host.convenienceEventsPage(resumed.id, {
      limit: 20,
      before: `live:${live.observationEpoch}:1`
    });
    const providerPage = await host.convenienceEventsPage(resumed.id, {
      limit: 20,
      before: liveBoundaryPage.nextCursor
    });
    const providerFrame = providerPage.frames[0];

    expect({
      liveBoundaryCursor: liveBoundaryPage.nextCursor,
      providerCursor: providerPage.nextCursor,
      providerEvents:
        providerFrame?.kind === 'patch'
          ? providerFrame.operations.map((operation) =>
              operation.op === 'upsert' ? { kind: operation.event.kind, text: operation.event.text } : null
            )
          : [],
      pageRequests
    }).toEqual({
      liveBoundaryCursor: 'provider:',
      providerCursor: 'provider:521',
      providerEvents: [{ kind: 'assistant-message', text: 'latest settled provider event' }],
      pageRequests: [
        { view: 'convenience', limit: 1 },
        { view: 'convenience', before: undefined, limit: 20 }
      ]
    });
  } finally {
    await host.stopAll();
    store.close();
    unregisterAgentAdapterImpl(provider);
    await rm(root, { recursive: true, force: true });
  }
});
