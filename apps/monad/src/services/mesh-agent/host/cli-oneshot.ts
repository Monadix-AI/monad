import type { MeshSessionView } from '@monad/protocol';
import type { LiveMeshSession } from '#/services/mesh-agent/host/host-types.ts';
import type { LiveRawStore } from '#/services/mesh-agent/live-raw-store.ts';
import type { prepareManagedProjectRuntime } from '#/services/mesh-agent/managed-project.ts';
import type { MeshAgentProcess } from '#/services/mesh-agent/runtime-types.ts';
import type { MeshAgentLaunchSpec, MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';
import type { MeshSessionRow, Store } from '#/store/db/index.ts';
import type { MeshAgentTargetId } from '#/store/db/mesh-sessions.ts';

import { createLogger } from '@monad/logger';
import { newId } from '@monad/protocol';

import { daemonTrackedSpawnOptions, supervisedSpawn } from '#/infra/spawn-supervisor.ts';
import { MeshAgentEventLog } from '#/services/mesh-agent/host/event-log.ts';
import { toView } from '#/services/mesh-agent/host/host-helpers.ts';
import { MeshAgentOutputPipeline } from '#/services/mesh-agent/host/output-pipeline.ts';
import { killMeshAgentProcess } from '#/services/mesh-agent/process.ts';
import { createStreamingTextDecoder } from '#/services/mesh-agent/stream-decoder.ts';

const log = createLogger('mesh-agent');

export interface MeshAgentOneshotRunnerContext {
  live: Map<string, LiveMeshSession>;
  store: Pick<Store, 'upsertMeshSession'>;
  events: MeshAgentEventLog;
  outputPipeline: MeshAgentOutputPipeline;
  buildSpawnEnv(adapter: MeshAgentProviderAdapter, launchEnv?: Record<string, string>): Promise<Record<string, string>>;
  trackProcess(pid: number): void;
  untrackProcess(pid: number): void;
  openLiveRawStore(id: string, epoch: string): LiveRawStore;
}

/** Runs `cli-oneshot` sessions: a logical session backed by NO persistent process — each turn spawns
 *  a fresh CLI with the directive baked into argv, streams its output, and lets it exit. */
export class MeshAgentOneshotRunner {
  constructor(private readonly ctx: MeshAgentOneshotRunnerContext) {}

  /** Register a `cli-oneshot` session: a logical session with NO persistent process. Each turn spawns a
   *  fresh CLI (see runTurn). Mirrors the persistent path's row/live/started bookkeeping. */
  start(args: {
    id: string;
    transcriptTargetId: MeshAgentTargetId;
    agentName: string;
    provider: MeshSessionRow['provider'];
    workingPath: string;
    runtimeRole: MeshSessionView['runtimeRole'];
    launch: MeshAgentLaunchSpec;
    adapter: MeshAgentProviderAdapter;
    managed: ReturnType<typeof prepareManagedProjectRuntime> | null;
    providerSessionRef: string | null;
    startedAt: string;
  }): MeshSessionView {
    const { id, transcriptTargetId, agentName, provider, workingPath, runtimeRole, launch, adapter, managed } = args;
    const observationEpoch = newId('oep');
    const liveRawStore = this.ctx.openLiveRawStore(id, observationEpoch);
    const row: MeshSessionRow = {
      id,
      transcriptTargetId,
      agentName,
      provider,
      workingPath,
      launchMode: 'cli-oneshot',
      runtimeRole,
      agentRuntimeId: runtimeRole === 'managed-project-agent' ? id : null,
      agentRuntimeTokenHash: managed?.tokenHash ?? null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'running',
      pid: null,
      providerSessionRef: args.providerSessionRef,
      outputSnapshot: '',
      exitCode: null,
      startedAt: args.startedAt,
      updatedAt: args.startedAt,
      exitedAt: null
    };
    this.ctx.store.upsertMeshSession(row);
    const live: LiveMeshSession = {
      id,
      transcriptTargetId,
      agentName,
      provider,
      runtimeRole,
      // cli-oneshot spawns a fresh stateless process per turn — no persistent channel to resolve an
      // approval through, so it never delegates (autopilot only).
      proxyApprovals: false,
      adapter,
      launchMode: 'cli-oneshot',
      oneshotSpec: launch,
      managedPrompt: managed?.prompt ?? null,
      providerSessionRef: args.providerSessionRef,
      pendingApprovals: new Map(),
      pendingEventPages: new Map(),
      pendingRequests: new Map(),
      startup: undefined,
      liveRawStore,
      observationEpoch,
      observationEpochReady: false,
      outputSeq: 0,
      nextRequestId: () => 0,
      kill: (signal) => {
        const l = this.ctx.live.get(id);
        if (!l?.oneshotTurnProc) return;
        if (l.oneshotTurnProc.supervision) l.oneshotTurnProc.supervision.stop('manual', signal ?? 'SIGTERM');
        else killMeshAgentProcess(l.oneshotTurnProc.pid, signal);
      }
    };
    this.ctx.live.set(id, live);
    this.ctx.events.emit(transcriptTargetId, 'mesh.started', {
      meshSessionId: id,
      agentName,
      provider,
      productIcon: adapter.productIcon,
      launchMode: 'cli-oneshot',
      workingPath,
      pid: null
    });
    return toView(row);
  }

  /** Run one `cli-oneshot` turn: spawn a fresh CLI with the directive baked into argv, stream its stdout
   *  into the transcript, and let it exit. The member's actual reply reaches the project via its
   *  `monad project post` callback (managed runtime), so we only need to run the process to completion. */
  async runTurn(live: LiveMeshSession, input: string): Promise<void> {
    const spec = live.oneshotSpec;
    const turnArgsFn = live.adapter.oneshotTurnArgs;
    if (!spec || !turnArgsFn) return;
    // cli-oneshot is STATELESS per turn (a fresh process, no --resume selector), so the managed
    // collaboration prompt must ride EVERY turn's directive — not just the first — or turns 2+ forget
    // the `monad project post/ask/read` contract and their reply never reaches the project.
    const directive = live.managedPrompt ? `${live.managedPrompt}\n\n---\n\n${input}` : input;
    const turnArgs = turnArgsFn(directive, { providerSessionRef: live.providerSessionRef });
    const spawnEnv = await this.ctx.buildSpawnEnv(live.adapter, spec.env);
    let proc: MeshAgentProcess;
    try {
      proc = supervisedSpawn(
        [...spec.argv, ...turnArgs],
        {
          cwd: spec.cwd,
          env: spawnEnv,
          detached: true,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe'
        },
        {
          ...daemonTrackedSpawnOptions({
            event: 'mesh.oneshot_spawn',
            log,
            context: {
              sessionId: live.transcriptTargetId,
              meshSessionId: live.id,
              agentName: live.agentName,
              provider: live.provider
            },
            kill: (child, signal) => killMeshAgentProcess(child.pid, signal),
            trackLabel: 'mesh-agent',
            tracker: {
              track: (pid) => this.ctx.trackProcess(pid),
              untrack: (pid) => this.ctx.untrackProcess(pid)
            }
          })
        }
      ) as MeshAgentProcess;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ctx.outputPipeline.output(live.transcriptTargetId, live.id, message, 'stderr', live.adapter);
      return;
    }
    live.oneshotTurnProc = proc;
    await proc.supervision?.tracked;
    // Surface BOTH streams into the transcript (stderr carries a provider's real errors), and await both
    // drains so all output is emitted before the turn is considered done.
    const pump = (stream: ReadableStream<Uint8Array> | undefined, name: 'stdout' | 'stderr'): Promise<void> => {
      if (!stream) return Promise.resolve();
      const decoder = createStreamingTextDecoder();
      return (async () => {
        for await (const data of stream) {
          const text = decoder.decode(data);
          if (text) this.ctx.outputPipeline.output(live.transcriptTargetId, live.id, text, name, live.adapter);
        }
        const rest = decoder.flush();
        if (rest) this.ctx.outputPipeline.output(live.transcriptTargetId, live.id, rest, name, live.adapter);
      })();
    };
    const drains = Promise.all([pump(proc.stdout, 'stdout'), pump(proc.stderr, 'stderr')]);
    const code = await proc.exited;
    await drains;
    if (live.oneshotTurnProc === proc) live.oneshotTurnProc = undefined;
    if (code !== 0) {
      this.ctx.outputPipeline.output(
        live.transcriptTargetId,
        live.id,
        `\n[${live.provider} turn exited with code ${code}]\n`,
        'stderr',
        live.adapter
      );
    }
    // The turn's process has exited. For a managed member the real reply arrives via its
    // `monad project post` callback (which already completed the thinking indicator); but if the CLI
    // finished WITHOUT posting, retire the dangling spinner so the member doesn't look stuck forever.
    // No-op when a post already settled it (nothing pending) — process exit is the definitive turn end.
    if (live.runtimeRole === 'managed-project-agent') {
      this.ctx.outputPipeline.emitManagedProjectOutput(live.transcriptTargetId, live.id, '', false, false);
    }
  }
}
