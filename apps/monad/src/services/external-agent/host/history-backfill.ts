import type { ExternalAgentObservationEvent } from '@monad/protocol';
import type {
  ExternalAgentEventPageRequest,
  ExternalAgentEventPageResult,
  ExternalAgentRuntimeHandle
} from '@monad/sdk-atom';
import type { ExternalAgentHostDeps } from '#/services/external-agent/host/host-types.ts';
import type { ExternalAgentProcess } from '#/services/external-agent/runtime-types.ts';
import type { ExternalAgentProviderAdapter } from '#/services/external-agent/types.ts';
import type { ExternalAgentSessionRow } from '#/store/db/index.ts';

import { createLogger } from '@monad/logger';

import { daemonChildProcesses } from '#/infra/daemon-child-processes.ts';
import { daemonTrackedSpawnOptions, supervisedSpawn, timeoutWithEscalation } from '#/infra/spawn-supervisor.ts';
import { connectAppServerStdio } from '#/services/external-agent/app-server-stdio.ts';
import { MAX_OUTPUT_SNAPSHOT } from '#/services/external-agent/constants.ts';
import { HISTORY_BACKFILL_TIMEOUT_MS } from '#/services/external-agent/host/host-constants.ts';
import { buildExternalAgentLaunch, resolveExternalAgentLaunchCommand } from '#/services/external-agent/index.ts';
import { killExternalAgentProcess } from '#/services/external-agent/process.ts';
import { createStreamingTextDecoder } from '#/services/external-agent/stream-decoder.ts';
import { externalAgentOutputEventSchema } from '#/services/external-agent/types.ts';

const log = createLogger('external-agent');

export async function providerHistoryEventsFromLocal(
  row: ExternalAgentSessionRow,
  adapter: ExternalAgentProviderAdapter
): Promise<ExternalAgentObservationEvent[] | null> {
  if (!row.providerSessionRef || !adapter.events.readPage) return null;
  const result = await adapter.events.readPage(
    {
      providerSessionRef: row.providerSessionRef,
      workingPath: row.workingPath,
      limitBytes: MAX_OUTPUT_SNAPSHOT
    },
    { limit: 100, sortDirection: 'desc' }
  );
  return result.state === 'available' && result.events.length > 0 ? result.events : null;
}

export interface ProviderHistoryViaCliHelpers {
  agents: ExternalAgentHostDeps['agents'];
  buildSpawnEnv(env?: Record<string, string>): Promise<Record<string, string>>;
  takeStructuredLines(id: string, stream: 'stdout' | 'stderr', chunk: string): string;
  dropStructuredBuffer(id: string): void;
}

export async function providerHistoryPageViaCli(
  row: ExternalAgentSessionRow,
  adapter: ExternalAgentProviderAdapter,
  request: ExternalAgentEventPageRequest,
  helpers: ProviderHistoryViaCliHelpers
): Promise<ExternalAgentEventPageResult | null> {
  const providerSessionRef = row.providerSessionRef ?? undefined;
  if (!providerSessionRef || !adapter.events.readPage) return null;
  const readPage = adapter.events.readPage;
  const agent = (await helpers.agents()).find(
    (candidate) => candidate.enabled && (candidate.name === row.agentName || candidate.provider === row.provider)
  );
  if (!agent) return null;
  const launch = resolveExternalAgentLaunchCommand(
    adapter,
    buildExternalAgentLaunch(agent, {
      workingPath: row.workingPath,
      launchMode: 'app-server',
      providerSessionRef
    })
  );
  if (launch.launchMode !== 'app-server') return null;
  const spawnEnv = await helpers.buildSpawnEnv(launch.env);
  const proc = supervisedSpawn(
    launch.argv,
    { cwd: launch.cwd, env: spawnEnv, detached: true, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    {
      ...daemonTrackedSpawnOptions({
        event: 'external_agent.history_spawn',
        log,
        context: {
          sessionId: row.transcriptTargetId,
          externalAgentSessionId: row.id,
          agentName: row.agentName,
          provider: row.provider
        },
        timeout: timeoutWithEscalation(HISTORY_BACKFILL_TIMEOUT_MS),
        kill: (child, signal) => killExternalAgentProcess(child.pid, signal),
        trackLabel: 'external-agent-history',
        tracker: daemonChildProcesses
      })
    }
  ) as ExternalAgentProcess;
  let requestSeq = 0;
  let settled = false;
  let historyStarted = false;
  let expectedResponseId: string | null = null;
  let resolveProviderPage: ((page: { items: unknown[]; nextCursor?: string }) => void) | undefined;
  let rejectProviderPage: ((error: Error) => void) | undefined;
  const historyId = `history:${row.id}:${Date.now()}`;
  const decoder = createStreamingTextDecoder();
  const handle: ExternalAgentRuntimeHandle = {
    launchMode: 'app-server',
    appServer: connectAppServerStdio(proc.stdin),
    providerSessionRef,
    pendingRequests: new Map<string | number, string>(),
    nextRequestId: () => requestSeq++,
    kill: (signal?: NodeJS.Signals) => killExternalAgentProcess(proc.pid, signal)
  };

  return await new Promise<ExternalAgentEventPageResult | null>((resolve) => {
    const finish = (result: ExternalAgentEventPageResult | null): void => {
      if (settled) return;
      settled = true;
      helpers.dropStructuredBuffer(historyId);
      rejectProviderPage?.(new Error('external agent history reader closed'));
      try {
        void proc.stdin?.end?.();
      } catch {}
      proc.supervision?.stop('manual', 'SIGTERM');
      resolve(result);
    };
    void proc.supervision?.timeoutElapsed?.then(() => finish(null));

    const startHistory = (): void => {
      if (historyStarted || handle.deferredThreadFrame) return;
      historyStarted = true;
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
          const structured = helpers.takeStructuredLines(historyId, 'stdout', text);
          if (!structured) continue;
          for (const event of adapter.parseOutput(structured, handle)) {
            const parsed = externalAgentOutputEventSchema.safeParse(event);
            if (!parsed.success) continue;
            if (parsed.data.type === 'connection_required' || parsed.data.type === 'provider_error') {
              finish(null);
              return;
            }
            if (parsed.data.type === 'session_ref') {
              startHistory();
              continue;
            }
            if (parsed.data.type !== 'history_page') continue;
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
      startHistory();
    } catch {
      finish(null);
    }
  });
}
