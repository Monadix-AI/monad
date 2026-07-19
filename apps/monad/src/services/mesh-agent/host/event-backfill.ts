import type { MeshAgentEventPageRequest, MeshAgentEventPageResult, MeshAgentRuntimeHandle } from '@monad/sdk-atom';
import type { MeshAgentHostDeps } from '#/services/mesh-agent/host/host-types.ts';
import type { MeshAgentProcess } from '#/services/mesh-agent/runtime-types.ts';
import type { MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';
import type { MeshSessionRow } from '#/store/db/index.ts';

import { createLogger } from '@monad/logger';

import { daemonChildProcesses } from '#/infra/daemon-child-processes.ts';
import { daemonTrackedSpawnOptions, supervisedSpawn, timeoutWithEscalation } from '#/infra/spawn-supervisor.ts';
import { connectAppServerStdio } from '#/services/mesh-agent/app-server-stdio.ts';
import { MAX_OUTPUT_SNAPSHOT } from '#/services/mesh-agent/constants.ts';
import { EVENT_PAGE_PROCESS_TIMEOUT_MS } from '#/services/mesh-agent/host/host-constants.ts';
import { buildMeshAgentLaunch, resolveMeshAgentLaunchCommand } from '#/services/mesh-agent/index.ts';
import { killMeshAgentProcess } from '#/services/mesh-agent/process.ts';
import { createStreamingTextDecoder } from '#/services/mesh-agent/stream-decoder.ts';
import { meshAgentOutputEventSchema } from '#/services/mesh-agent/types.ts';

const log = createLogger('mesh-agent');

export interface ProviderEventViaCliHelpers {
  agents: MeshAgentHostDeps['agents'];
  buildSpawnEnv(adapter: MeshAgentProviderAdapter, env?: Record<string, string>): Promise<Record<string, string>>;
  takeStructuredLines(id: string, stream: 'stdout' | 'stderr', chunk: string): string;
  dropStructuredBuffer(id: string): void;
}

export async function providerEventPageViaCli(
  row: MeshSessionRow,
  adapter: MeshAgentProviderAdapter,
  request: MeshAgentEventPageRequest,
  helpers: ProviderEventViaCliHelpers
): Promise<MeshAgentEventPageResult | null> {
  const providerSessionRef = row.providerSessionRef ?? undefined;
  if (!providerSessionRef || !adapter.events.readPage) return null;
  const readPage = adapter.events.readPage;
  const agent = (await helpers.agents()).find(
    (candidate) => candidate.enabled && (candidate.name === row.agentName || candidate.provider === row.provider)
  );
  if (!agent) return null;
  const launch = resolveMeshAgentLaunchCommand(
    adapter,
    buildMeshAgentLaunch(agent, {
      workingPath: row.workingPath,
      launchMode: 'app-server',
      providerSessionRef
    })
  );
  if (launch.launchMode !== 'app-server') return null;
  const spawnEnv = await helpers.buildSpawnEnv(adapter, launch.env);
  const proc = supervisedSpawn(
    launch.argv,
    { cwd: launch.cwd, env: spawnEnv, detached: true, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    {
      ...daemonTrackedSpawnOptions({
        event: 'mesh.event_page_spawn',
        log,
        context: {
          sessionId: row.transcriptTargetId,
          meshSessionId: row.id,
          agentName: row.agentName,
          provider: row.provider
        },
        timeout: timeoutWithEscalation(EVENT_PAGE_PROCESS_TIMEOUT_MS),
        kill: (child, signal) => killMeshAgentProcess(child.pid, signal),
        trackLabel: 'mesh-agent-events',
        tracker: daemonChildProcesses
      })
    }
  ) as MeshAgentProcess;
  let requestSeq = 0;
  let settled = false;
  let eventPageStarted = false;
  let expectedResponseId: string | null = null;
  let resolveProviderPage: ((page: { items: unknown[]; nextCursor?: string }) => void) | undefined;
  let rejectProviderPage: ((error: Error) => void) | undefined;
  const eventPageId = `events:${row.id}:${Date.now()}`;
  const decoder = createStreamingTextDecoder();
  const handle: MeshAgentRuntimeHandle = {
    launchMode: 'app-server',
    appServer: connectAppServerStdio(proc.stdin),
    providerSessionRef,
    pendingRequests: new Map<string | number, string>(),
    nextRequestId: () => requestSeq++,
    kill: (signal?: NodeJS.Signals) => killMeshAgentProcess(proc.pid, signal)
  };

  return await new Promise<MeshAgentEventPageResult | null>((resolve) => {
    const finish = (result: MeshAgentEventPageResult | null): void => {
      if (settled) return;
      settled = true;
      helpers.dropStructuredBuffer(eventPageId);
      rejectProviderPage?.(new Error('MeshAgent event reader closed'));
      try {
        void proc.stdin?.end?.();
      } catch {}
      proc.supervision?.stop('manual', 'SIGTERM');
      resolve(result);
    };
    void proc.supervision?.timeoutElapsed?.then(() => finish(null));

    const startEventPage = (): void => {
      if (eventPageStarted) return;
      eventPageStarted = true;
      void readPage(
        {
          providerSessionRef,
          workingPath: row.workingPath,
          limitBytes: MAX_OUTPUT_SNAPSHOT,
          requestProviderPage: (send) =>
            new Promise((resolvePage, rejectPage) => {
              resolveProviderPage = resolvePage;
              rejectProviderPage = rejectPage;
              try {
                expectedResponseId = String(send(handle));
              } catch (error) {
                rejectPage(error instanceof Error ? error : new Error(String(error)));
              }
            })
        },
        request
      ).then(
        (result) => finish(result),
        () => finish(null)
      );
    };

    void (async () => {
      try {
        for await (const data of proc.stdout ?? []) {
          const text = decoder.decode(data);
          if (!text) continue;
          const structured = helpers.takeStructuredLines(eventPageId, 'stdout', text);
          if (!structured) continue;
          for (const event of adapter.parseOutput(structured, handle)) {
            const parsed = meshAgentOutputEventSchema.safeParse(event);
            if (!parsed.success) continue;
            if (parsed.data.type === 'connection_required' || parsed.data.type === 'provider_error') {
              finish(null);
              return;
            }
            if (parsed.data.type === 'session_ref') {
              startEventPage();
              continue;
            }
            if (parsed.data.type !== 'event_page') continue;
            if (expectedResponseId && String(parsed.data.payload.responseId) !== expectedResponseId) continue;
            resolveProviderPage?.({
              items: Array.isArray(parsed.data.payload.items) ? parsed.data.payload.items : [],
              ...(typeof parsed.data.payload.nextCursor === 'string'
                ? { nextCursor: parsed.data.payload.nextCursor }
                : {})
            });
          }
        }
        finish(null);
      } catch {
        finish(null);
      }
    })();
    void (async () => {
      try {
        for await (const _ of proc.stderr ?? []) {
        }
      } catch {}
    })();
    try {
      adapter.initialize?.(handle, { workingPath: row.workingPath, providerSessionRef });
      startEventPage();
    } catch {
      finish(null);
    }
  });
}
