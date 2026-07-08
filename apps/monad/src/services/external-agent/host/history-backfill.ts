import type { ExternalAgentHostDeps } from '#/services/external-agent/host/host-types.ts';
import type { ExternalAgentProcess } from '#/services/external-agent/runtime-types.ts';
import type { ExternalAgentProviderAdapter } from '#/services/external-agent/types.ts';
import type { ExternalAgentSessionRow } from '#/store/db/index.ts';

import { daemonChildProcesses } from '#/infra/daemon-child-processes.ts';
import { connectAppServerStdio } from '#/services/external-agent/app-server-stdio.ts';
import { MAX_OUTPUT_SNAPSHOT } from '#/services/external-agent/constants.ts';
import { HISTORY_BACKFILL_TIMEOUT_MS } from '#/services/external-agent/host/host-constants.ts';
import { buildExternalAgentLaunch, resolveExternalAgentLaunchCommand } from '#/services/external-agent/index.ts';
import { killExternalAgentProcess } from '#/services/external-agent/process.ts';
import { createStreamingTextDecoder } from '#/services/external-agent/stream-decoder.ts';
import { externalAgentOutputEventSchema } from '#/services/external-agent/types.ts';

export async function providerHistoryOutputFromLocal(
  row: ExternalAgentSessionRow,
  adapter: ExternalAgentProviderAdapter
): Promise<string | null> {
  if (!row.providerSessionRef) return null;
  return (
    (await adapter.historyOutput?.({
      providerSessionRef: row.providerSessionRef,
      workingPath: row.workingPath,
      limitBytes: MAX_OUTPUT_SNAPSHOT
    })) ?? null
  );
}

export interface ProviderHistoryViaCliHelpers {
  agents: ExternalAgentHostDeps['agents'];
  buildSpawnEnv(env?: Record<string, string>): Promise<Record<string, string>>;
  takeStructuredLines(id: string, stream: 'stdout' | 'stderr', chunk: string): string;
  dropStructuredBuffer(id: string): void;
}

export async function providerHistoryOutputViaCli(
  row: ExternalAgentSessionRow,
  adapter: ExternalAgentProviderAdapter,
  helpers: ProviderHistoryViaCliHelpers
): Promise<string | null> {
  const providerSessionRef = row.providerSessionRef ?? undefined;
  const historyPageOutput = adapter.historyPageOutput;
  if (!providerSessionRef || !adapter.requestHistoryPage || !historyPageOutput) return null;
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
  const proc = Bun.spawn(launch.argv, {
    cwd: launch.cwd,
    env: spawnEnv,
    detached: true,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  }) as ExternalAgentProcess;
  daemonChildProcesses.track(proc.pid, 'external-agent-history', () => killExternalAgentProcess(proc.pid));
  void proc.exited.then(() => daemonChildProcesses.untrack(proc.pid));
  let requestSeq = 0;
  let settled = false;
  let expectedResponseId: string | null = null;
  const historyId = `history:${row.id}:${Date.now()}`;
  const decoder = createStreamingTextDecoder();
  const handle = {
    launchMode: 'app-server' as const,
    appServer: connectAppServerStdio(proc.stdin),
    providerSessionRef,
    pendingRequests: new Map<string | number, string>(),
    nextRequestId: () => requestSeq++,
    kill: (signal?: NodeJS.Signals) => killExternalAgentProcess(proc.pid, signal)
  };
  return await new Promise<string | null>((resolve) => {
    const finish = (output: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      helpers.dropStructuredBuffer(historyId);
      try {
        void proc.stdin?.end?.();
      } catch {}
      killExternalAgentProcess(proc.pid);
      daemonChildProcesses.untrack(proc.pid);
      resolve(output);
    };
    const timeout = setTimeout(() => finish(null), HISTORY_BACKFILL_TIMEOUT_MS);
    void (async () => {
      try {
        for await (const data of proc.stdout ?? []) {
          const text = decoder.decode(data);
          if (!text) continue;
          const structured = helpers.takeStructuredLines(historyId, 'stdout', text);
          if (!structured) continue;
          for (const event of adapter.parseOutput(structured, handle)) {
            const parsed = externalAgentOutputEventSchema.safeParse(event);
            if (!parsed.success || parsed.data.type !== 'history_page') continue;
            if (expectedResponseId && String(parsed.data.payload.responseId) !== expectedResponseId) continue;
            const output = historyPageOutput({
              providerSessionRef,
              workingPath: row.workingPath,
              limitBytes: MAX_OUTPUT_SNAPSHOT,
              page: {
                items: Array.isArray(parsed.data.payload.items) ? parsed.data.payload.items : [],
                ...(typeof parsed.data.payload.nextCursor === 'string'
                  ? { nextCursor: parsed.data.payload.nextCursor }
                  : {})
              }
            });
            finish(output ?? null);
            return;
          }
        }
        const remaining = decoder.flush();
        if (remaining) helpers.takeStructuredLines(historyId, 'stdout', remaining);
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
      const requestHistoryPage = adapter.requestHistoryPage;
      if (!requestHistoryPage) {
        finish(null);
        return;
      }
      expectedResponseId = String(requestHistoryPage(handle, { limit: 20, sortDirection: 'desc', itemsView: 'full' }));
    } catch {
      finish(null);
    }
  });
}
