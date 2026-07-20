import type { Logger } from '@monad/logger';
import type { MeshAgentView, MeshSessionView, ProjectId } from '@monad/protocol';
import type { MeshAgentOutputEvent, MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';
import type { MeshSessionRow } from '#/store/db/index.ts';
import type { MeshAgentTargetId } from '#/store/db/mesh-sessions.ts';
import type { MeshFixtureTap } from '../fixture-tap.ts';
import type { LiveRawStore } from '../live-raw-store.ts';
import type { LiveMeshSession, MeshAgentHostDeps } from './host-types.ts';

import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { newId } from '@monad/protocol';

import { MeshAgentError } from '../errors.ts';
import { getMeshAgentProviderAdapter, resolveMeshAgentExecutable } from '../index.ts';
import { cleanupManagedProjectRuntimeToken, prepareManagedProjectRuntime } from '../managed-project.ts';
import { resolveMeshAgentManagedServerUrl } from '../managed-server-url.ts';
import { BunSessionEventRuntimeResourceFactory } from '../session-event-runtime/bun-resource-factory.ts';
import { SessionEventRuntimeExecutor } from '../session-event-runtime/executor.ts';
import { createRawStreamDecoders } from '../stream-decoder.ts';
import { MeshAgentEventLog } from './event-log.ts';
import { toView } from './host-helpers.ts';
import { MeshAgentObservationHub } from './observation-hub.ts';
import { MeshAgentOutputPipeline } from './output-pipeline.ts';

export interface MeshSessionEventRuntimeStartArgs {
  transcriptTargetId: MeshAgentTargetId;
  agentName: string;
  displayName?: string;
  templateAgentName?: string;
  workingPath: string;
  runtimeRole?: MeshSessionView['runtimeRole'];
  providerSessionRef?: string;
  modelName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  customPrompt?: string;
  allowAutopilot?: boolean;
  initialInput?: string;
}

interface MeshSessionEventRuntimeLauncherContext {
  deps: MeshAgentHostDeps;
  live: Map<string, LiveMeshSession>;
  log: Logger;
  events: MeshAgentEventLog;
  observation: MeshAgentObservationHub;
  outputPipeline: MeshAgentOutputPipeline;
  requireAgent(name: string): Promise<MeshAgentView>;
  buildSpawnEnv(adapter: MeshAgentProviderAdapter, launchEnv?: Record<string, string>): Promise<Record<string, string>>;
  trackProcess(pid: number): Promise<void>;
  untrackProcess(pid: number): void;
  openLiveRawStore(id: string, epoch: string): LiveRawStore;
  fixtureTap?: MeshFixtureTap;
}

export class MeshSessionEventRuntimeLauncher {
  constructor(private readonly ctx: MeshSessionEventRuntimeLauncherContext) {}

  async start(args: MeshSessionEventRuntimeStartArgs): Promise<MeshSessionView> {
    const runtimeRole = args.runtimeRole ?? 'interactive';
    const willBeManaged = runtimeRole === 'managed-project-agent';
    let agent = await this.ctx.requireAgent(args.templateAgentName ?? args.agentName);
    const adapter = getMeshAgentProviderAdapter(agent.provider);
    if (!adapter.createSessionRuntime) {
      throw new MeshAgentError(
        'unsupported_capability',
        `MeshAgent provider "${adapter.label}" does not expose a resumable structured session-event runtime`
      );
    }
    const workingPath = this.resolveWorkingPath(args.workingPath);
    const id = newId('mesh');
    const allowAutopilot = args.allowAutopilot ?? agent.allowAutopilot;
    if (allowAutopilot !== agent.allowAutopilot) agent = { ...agent, allowAutopilot };
    const skipProviderApprovals = willBeManaged;
    const managed = willBeManaged
      ? prepareManagedProjectRuntime({
          monadHome: this.ctx.deps.monadHome ?? dirname(this.ctx.deps.meshAgentProcessRegistryPath ?? workingPath),
          serverUrl: resolveMeshAgentManagedServerUrl({
            serverUrl: this.ctx.deps.serverUrl,
            networkHttps: this.ctx.deps.networkHttps
          }),
          agentName: args.agentName,
          displayName: args.displayName,
          projectId: args.transcriptTargetId as ProjectId,
          meshSessionId: id,
          provider: agent.provider,
          modelName: args.modelName,
          modelId: args.modelId,
          reasoningEffort: args.reasoningEffort,
          speed: args.speed,
          customPrompt: args.customPrompt,
          baseEnvPath: Bun.env.PATH,
          skipProviderApprovals
        })
      : null;
    if (willBeManaged && args.initialInput === undefined) {
      throw new Error('managed MeshAgent startup requires initial input');
    }
    const startInput =
      managed && args.initialInput !== undefined
        ? {
            immutableInstructions: { text: managed.prompt, file: managed.promptFile },
            initialTurn: { text: args.initialInput, attachments: [] }
          }
        : undefined;
    const now = new Date().toISOString();
    const baseRow: MeshSessionRow = {
      id,
      transcriptTargetId: args.transcriptTargetId,
      agentName: args.agentName,
      provider: agent.provider,
      workingPath,
      runtimeRole,
      agentRuntimeId: willBeManaged ? id : null,
      agentRuntimeTokenHash: managed?.tokenHash ?? null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'starting',
      pid: null,
      providerSessionRef: args.providerSessionRef ?? null,
      outputSnapshot: '',
      exitCode: null,
      startedAt: now,
      updatedAt: now,
      exitedAt: null
    };
    let runtimeSetup: {
      definition: ReturnType<NonNullable<MeshAgentProviderAdapter['createSessionRuntime']>>;
      executable: string;
    };
    try {
      runtimeSetup = {
        definition: adapter.createSessionRuntime(agent, {
          workingPath,
          extraWorkingPaths: managed ? [managed.workspace] : undefined,
          providerSessionRef: args.providerSessionRef,
          startInput,
          skipProviderApprovals,
          mcpConfigArgs: managed?.mcpConfigArgs,
          env: managed?.env,
          modelName: args.modelName,
          modelId: args.modelId,
          reasoningEffort: args.reasoningEffort,
          speed: args.speed
        }),
        executable: resolveMeshAgentExecutable(agent, adapter)
      };
    } catch (error) {
      if (managed) cleanupManagedProjectRuntimeToken(managed.workspace);
      const failedAt = new Date().toISOString();
      this.ctx.deps.store.upsertMeshSession({
        ...baseRow,
        state: 'failed',
        outputSnapshot: error instanceof Error ? error.message : String(error),
        updatedAt: failedAt,
        exitedAt: failedAt
      });
      this.ctx.events.emit(args.transcriptTargetId, 'mesh.exited', {
        meshSessionId: id,
        exitCode: null,
        state: 'failed'
      });
      throw error;
    }
    const { definition, executable } = runtimeSetup;
    const observationEpoch = newId('oep');
    const liveRawStore = this.ctx.openLiveRawStore(id, observationEpoch);
    let activationSequence = 0;
    let terminalHandled = false;
    let rawDecoders = createRawStreamDecoders();
    let runtime: SessionEventRuntimeExecutor;
    const live: LiveMeshSession = {
      id,
      transcriptTargetId: args.transcriptTargetId,
      agentName: args.agentName,
      displayName: args.displayName,
      provider: agent.provider,
      workingPath,
      runtimeRole,
      proxyApprovals: false,
      adapter,
      providerSessionRef: args.providerSessionRef ?? null,
      pendingApprovals: new Map(),
      liveRawStore,
      observationEpoch,
      connectionOpen: false,
      outputSeq: 0,
      kill: (signal) => {
        if (signal) void runtime.interrupt().catch(() => runtime.close());
        else void runtime.close();
      }
    };
    runtime = new SessionEventRuntimeExecutor({
      definition,
      executable,
      allowedWorkingRoot: workingPath,
      workingPath,
      providerSessionRef: args.providerSessionRef,
      resourceFactory: new BunSessionEventRuntimeResourceFactory({
        buildEnv: (env) => this.ctx.buildSpawnEnv(adapter, env),
        onSpawn: (pid) => this.ctx.trackProcess(pid),
        onExit: (pid) => this.ctx.untrackProcess(pid)
      }),
      createObservationEpoch: () => {
        if (activationSequence++ === 0) return live.observationEpoch;
        void this.ctx.fixtureTap?.flush(id, live.observationEpoch);
        void live.liveRawStore.closeAndDelete();
        live.observationEpoch = newId('oep');
        live.liveRawStore = this.ctx.openLiveRawStore(id, live.observationEpoch);
        live.outputSeq = 0;
        rawDecoders = createRawStreamDecoders();
        return live.observationEpoch;
      },
      captureRaw: async (packet, epoch) => {
        if (epoch !== live.observationEpoch) throw new Error('MeshAgent observation epoch changed during capture');
        const stream = packet.source === 'stderr' ? ('stderr' as const) : ('stdout' as const);
        const payload = rawDecoders[stream].decode(packet.bytes);
        if (payload === '') return;
        live.outputSeq = live.liveRawStore.append({
          stream,
          payload,
          observedAt: packet.receivedAt
        }).seq;
        this.ctx.fixtureTap?.record({
          provider: adapter.provider,
          meshSessionId: id,
          observationEpoch: epoch,
          stream,
          payload,
          observedAt: packet.receivedAt
        });
        this.ctx.observation.publish(id);
      },
      consumeEvent: async (event) => {
        if (event.type === 'provider_session_identified') {
          live.providerSessionRef = event.payload.providerSessionRef;
          this.ctx.deps.store.updateMeshSessionRef(id, event.payload.providerSessionRef);
          return;
        }
        this.ctx.outputPipeline.structuredEvent(args.transcriptTargetId, id, adapter, event as MeshAgentOutputEvent);
      },
      onSnapshot: (snapshot) => {
        const updatedAt = new Date().toISOString();
        const terminal = snapshot.lifecycle.state === 'terminal' ? snapshot.lifecycle.termination : undefined;
        this.ctx.deps.store.upsertMeshSession({
          ...baseRow,
          state: terminal?.kind ?? (snapshot.lifecycle.state === 'active' ? 'running' : 'starting'),
          pid: snapshot.activity.state === 'running' ? snapshot.activity.pid : null,
          providerSessionRef: snapshot.providerSessionRef ?? null,
          exitCode: terminal?.exitCode ?? null,
          updatedAt,
          exitedAt: terminal?.at ?? null
        });
        if (snapshot.connection.state === 'connected' && !live.connectionOpen) {
          live.connectionOpen = true;
          this.ctx.events.publish(args.transcriptTargetId, 'mesh.session.connection.opened', {
            meshSessionId: id,
            provider: agent.provider,
            observationEpoch: live.observationEpoch
          });
        } else if (snapshot.connection.state === 'inactive' && live.connectionOpen) {
          live.connectionOpen = false;
          this.ctx.events.publish(args.transcriptTargetId, 'mesh.session.connection.closed', {
            meshSessionId: id,
            provider: agent.provider,
            observationEpoch: live.observationEpoch,
            reason: terminal?.kind ?? 'exited'
          });
        }
        if (terminal && terminal.kind !== 'stopped' && !terminalHandled) {
          terminalHandled = true;
          this.ctx.live.delete(id);
          void this.ctx.fixtureTap?.flush(id, live.observationEpoch);
          void live.liveRawStore.closeAndDelete();
          if (managed) cleanupManagedProjectRuntimeToken(managed.workspace);
          this.ctx.events.emit(args.transcriptTargetId, 'mesh.exited', {
            meshSessionId: id,
            exitCode: terminal.exitCode ?? null,
            state: terminal.kind
          });
        }
      }
    });
    live.sessionEventRuntime = runtime;
    this.ctx.live.set(id, live);
    this.ctx.deps.store.upsertMeshSession(baseRow);
    try {
      const snapshot = await runtime.open(startInput?.initialTurn);
      const pid = snapshot.activity.state === 'running' ? snapshot.activity.pid : null;
      const row: MeshSessionRow = {
        ...baseRow,
        state: 'running',
        pid,
        providerSessionRef: snapshot.providerSessionRef ?? null,
        updatedAt: new Date().toISOString()
      };
      this.ctx.deps.store.upsertMeshSession(row);
      this.ctx.events.emit(args.transcriptTargetId, 'mesh.started', {
        meshSessionId: id,
        agentName: args.agentName,
        provider: agent.provider,
        productIcon: adapter.productIcon,
        workingPath,
        pid
      });
      return toView(row, 0, snapshot);
    } catch (error) {
      this.ctx.live.delete(id);
      await runtime.close().catch(() => undefined);
      await liveRawStore.closeAndDelete();
      if (managed) cleanupManagedProjectRuntimeToken(managed.workspace);
      const failedAt = new Date().toISOString();
      this.ctx.deps.store.upsertMeshSession({
        ...baseRow,
        state: 'failed',
        outputSnapshot: error instanceof Error ? error.message : String(error),
        updatedAt: failedAt,
        exitedAt: failedAt
      });
      throw error;
    }
  }

  private resolveWorkingPath(path: string): string {
    if (!isAbsolute(path)) throw new Error('workingPath must be absolute');
    let resolved: string;
    try {
      resolved = realpathSync(path);
    } catch {
      throw new Error(`workingPath must be an existing directory: ${path}`);
    }
    if (!statSync(resolved).isDirectory()) throw new Error(`workingPath must be an existing directory: ${path}`);
    return resolved;
  }
}
