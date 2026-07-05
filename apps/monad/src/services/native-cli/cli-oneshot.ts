import type { NativeCliSessionView, TranscriptTargetId } from '@monad/protocol';
import type { LiveNativeCliSession } from '@/services/native-cli/host-types.ts';
import type { prepareManagedProjectRuntime } from '@/services/native-cli/managed-project.ts';
import type { NativeCliProcess } from '@/services/native-cli/runtime-types.ts';
import type { NativeCliLaunchSpec, NativeCliProviderAdapter } from '@/services/native-cli/types.ts';
import type { NativeCliSessionRow, Store } from '@/store/db/index.ts';

import { BoundedOutputBuffer } from '@/services/native-cli/bounded-output-buffer.ts';
import { MAX_OUTPUT_SNAPSHOT } from '@/services/native-cli/constants.ts';
import { NativeCliEventLog } from '@/services/native-cli/event-log.ts';
import { toView } from '@/services/native-cli/host-helpers.ts';
import { NativeCliOutputPipeline } from '@/services/native-cli/output-pipeline.ts';
import { killNativeCliProcess } from '@/services/native-cli/process.ts';
import { createStreamingTextDecoder } from '@/services/native-cli/stream-decoder.ts';

export interface NativeCliOneshotRunnerContext {
  live: Map<string, LiveNativeCliSession>;
  store: Pick<Store, 'upsertNativeCliSession'>;
  events: NativeCliEventLog;
  outputPipeline: NativeCliOutputPipeline;
  buildSpawnEnv(launchEnv?: Record<string, string>): Promise<Record<string, string>>;
  trackProcess(pid: number): void;
  untrackProcess(pid: number): void;
}

/** Runs `cli-oneshot` sessions: a logical session backed by NO persistent process — each turn spawns
 *  a fresh CLI with the directive baked into argv, streams its output, and lets it exit. */
export class NativeCliOneshotRunner {
  constructor(private readonly ctx: NativeCliOneshotRunnerContext) {}

  /** Register a `cli-oneshot` session: a logical session with NO persistent process. Each turn spawns a
   *  fresh CLI (see runTurn). Mirrors the persistent path's row/live/started bookkeeping. */
  start(args: {
    id: string;
    transcriptTargetId: TranscriptTargetId;
    agentName: string;
    provider: NativeCliSessionRow['provider'];
    workingPath: string;
    runtimeRole: NativeCliSessionView['runtimeRole'];
    launch: NativeCliLaunchSpec;
    adapter: NativeCliProviderAdapter;
    managed: ReturnType<typeof prepareManagedProjectRuntime> | null;
    providerSessionRef: string | null;
    startedAt: string;
  }): NativeCliSessionView {
    const { id, transcriptTargetId, agentName, provider, workingPath, runtimeRole, launch, adapter, managed } = args;
    const row: NativeCliSessionRow = {
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
    this.ctx.store.upsertNativeCliSession(row);
    const live: LiveNativeCliSession = {
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
      pendingHistoryPages: new Map(),
      pendingRequests: new Map(),
      startup: undefined,
      outputBuffer: new BoundedOutputBuffer(MAX_OUTPUT_SNAPSHOT),
      outputSeq: 0,
      snapshotFlushTimer: null,
      nextRequestId: () => 0,
      kill: (signal) => {
        const l = this.ctx.live.get(id);
        if (l?.oneshotTurnProc) killNativeCliProcess(l.oneshotTurnProc.pid, signal);
      }
    };
    this.ctx.live.set(id, live);
    this.ctx.events.emit(transcriptTargetId, 'native_cli.started', {
      nativeCliSessionId: id,
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
  async runTurn(live: LiveNativeCliSession, input: string): Promise<void> {
    const spec = live.oneshotSpec;
    const turnArgsFn = live.adapter.oneshotTurnArgs;
    if (!spec || !turnArgsFn) return;
    // cli-oneshot is STATELESS per turn (a fresh process, no --resume selector), so the managed
    // collaboration prompt must ride EVERY turn's directive — not just the first — or turns 2+ forget
    // the `monad project post/ask/read` contract and their reply never reaches the project.
    const directive = live.managedPrompt ? `${live.managedPrompt}\n\n---\n\n${input}` : input;
    const turnArgs = turnArgsFn(directive, { providerSessionRef: live.providerSessionRef });
    const spawnEnv = await this.ctx.buildSpawnEnv(spec.env);
    let proc: NativeCliProcess;
    try {
      proc = Bun.spawn([...spec.argv, ...turnArgs], {
        cwd: spec.cwd,
        env: spawnEnv,
        detached: true,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe'
      }) as NativeCliProcess;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ctx.outputPipeline.output(live.transcriptTargetId, live.id, message, 'stderr', live.adapter);
      this.ctx.outputPipeline.flushSnapshot(live.id);
      return;
    }
    live.oneshotTurnProc = proc;
    this.ctx.trackProcess(proc.pid);
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
    this.ctx.untrackProcess(proc.pid);
    if (live.oneshotTurnProc === proc) live.oneshotTurnProc = undefined;
    this.ctx.outputPipeline.flushSnapshot(live.id);
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
