import type { Logger } from '@monad/logger';
import type { MeshAgentSessionUsage, MeshAgentView, MeshSessionId, MeshSessionView, ProjectId } from '@monad/protocol';
import type { MeshAgentOutputEvent, MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';
import type { MeshSessionRow } from '#/store/db/index.ts';
import type { MeshAgentTargetId } from '#/store/db/mesh-sessions.ts';
import type { MeshFixtureTap } from '../fixture-tap.ts';
import type { LiveRawStore } from '../live-raw-store.ts';
import type {
  LiveMeshSession,
  ManagedProjectLoopEventHandler,
  MeshAgentApprovalMode,
  MeshAgentHostDeps
} from './host-types.ts';

import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { meshAgentSessionUsageSchema, newId } from '@monad/protocol';

import { MeshAgentError } from '../errors.ts';
import { getMeshAgentProviderAdapter, resolveMeshAgentCapabilities, resolveMeshAgentExecutable } from '../index.ts';
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
  projectId?: ProjectId;
  agentName: string;
  // Owning ProjectMember for a managed-project-agent runtime. Ownership + the member's SessionBinding
  // current pointer are established from this BEFORE the provider's initial turn opens, so the delivery
  // cursor path can resolve the owner strictly from the runtime row. Required for managed starts.
  projectMemberId?: string;
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
  getManagedProjectLoopEventHandler(): ManagedProjectLoopEventHandler | null;
  requireAgent(name: string): Promise<MeshAgentView>;
  buildSpawnEnv(adapter: MeshAgentProviderAdapter, launchEnv?: Record<string, string>): Promise<Record<string, string>>;
  trackProcess(pid: number): Promise<void>;
  untrackProcess(pid: number): void;
  openLiveRawStore(id: string, epoch: string): LiveRawStore;
  publishSessionUsage(id: string, usage: MeshAgentSessionUsage): boolean;
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
    this.ctx.log.debug(
      {
        event: 'mesh.runtime.start_requested',
        sessionId: args.transcriptTargetId,
        memberId: args.projectMemberId ?? null,
        meshSessionId: id,
        runtimeGeneration: id,
        pid: null
      },
      'native cli start requested'
    );
    const allowAutopilot = args.allowAutopilot ?? agent.allowAutopilot;
    if (willBeManaged && allowAutopilot && adapter.executionCapabilities?.autopilot !== true) {
      throw new MeshAgentError(
        'unsupported_capability',
        `MeshAgent provider "${adapter.label}" does not support autopilot`
      );
    }
    if (args.speed === 'fast') {
      const model = args.modelId ?? args.modelName;
      if (adapter.executionCapabilities?.fastMode !== true) {
        throw new MeshAgentError(
          'unsupported_capability',
          `MeshAgent provider "${adapter.label}" does not support fast mode`
        );
      }
      const [capabilities] = await resolveMeshAgentCapabilities([agent]);
      if (capabilities?.speedsByModel?.[model ?? 'default']?.includes('fast') !== true) {
        throw new MeshAgentError(
          'unsupported_capability',
          `MeshAgent provider "${adapter.label}" does not support fast mode for model "${model ?? 'default'}"`
        );
      }
    }
    if (allowAutopilot !== agent.allowAutopilot) agent = { ...agent, allowAutopilot };
    const approvalMode: MeshAgentApprovalMode = willBeManaged
      ? allowAutopilot
        ? 'autopilot'
        : 'delegated'
      : 'interactive';
    const skipProviderApprovals = approvalMode === 'autopilot';
    const managed = willBeManaged
      ? prepareManagedProjectRuntime({
          monadHome: this.ctx.deps.monadHome ?? dirname(this.ctx.deps.meshAgentProcessRegistryPath ?? workingPath),
          serverUrl: resolveMeshAgentManagedServerUrl({
            serverUrl: this.ctx.deps.serverUrl,
            networkHttps: this.ctx.deps.networkHttps
          }),
          agentName: args.agentName,
          agentId: args.projectMemberId,
          displayName: args.displayName,
          projectId: args.projectId ?? (args.transcriptTargetId as ProjectId),
          sessionId: args.transcriptTargetId,
          meshSessionId: id,
          workingPath,
          provider: agent.provider,
          modelName: args.modelName,
          modelId: args.modelId,
          reasoningEffort: args.reasoningEffort,
          speed: args.speed,
          customPrompt: args.customPrompt,
          baseEnvPath: Bun.env.PATH,
          agentCommand: agent.command,
          agentEnv: agent.env,
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
          extraWorkingPaths: managed
            ? [
                managed.workspaces.shared,
                managed.workspaces.agent,
                managed.workspaces.session,
                managed.workspaces.runtime
              ]
            : undefined,
          providerSessionRef: args.providerSessionRef,
          startInput,
          skipProviderApprovals,
          mcpConfigArgs: managed?.mcpConfigArgs,
          managedMcpServer: managed?.mcpServer,
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
    let previousActivityState: MeshSessionView['activity']['state'] | undefined;
    let lastPid: number | null = null;
    let resumePending = false;
    const live: LiveMeshSession = {
      id,
      transcriptTargetId: args.transcriptTargetId,
      agentName: args.agentName,
      displayName: args.displayName,
      provider: agent.provider,
      workingPath,
      runtimeRole,
      approvalMode,
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
      resourceFactory:
        this.ctx.deps.resourceFactory ??
        new BunSessionEventRuntimeResourceFactory({
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
        if (event.type === 'session_usage_updated') {
          const fallback = meshAgentSessionUsageSchema.parse(event.payload);
          if (!this.ctx.publishSessionUsage(id, fallback)) return;
          const providerSessionRef = live.providerSessionRef;
          const sessionUsage = adapter.sessionUsage;
          if (!sessionUsage || !providerSessionRef) return;
          void (async () => {
            try {
              const usage = await sessionUsage.read({
                providerSessionRef,
                workingPath,
                executable,
                env: await this.ctx.buildSpawnEnv(adapter, agent.env)
              });
              if (usage) this.ctx.publishSessionUsage(id, usage);
            } catch {}
          })();
          return;
        }
        this.ctx.outputPipeline.structuredEvent(
          args.transcriptTargetId,
          id,
          adapter,
          event as MeshAgentOutputEvent,
          agent.name
        );
      },
      onSnapshot: (snapshot) => {
        if (snapshot.activity.state === 'running') lastPid = snapshot.activity.pid;
        const idleTimeoutMs =
          definition.plan.processModel === 'resident' ? definition.plan.suspend?.idleTimeoutMs : undefined;
        if (snapshot.activity.state === 'suspended' && previousActivityState !== 'suspended' && idleTimeoutMs) {
          resumePending = true;
          this.ctx.events.emit(args.transcriptTargetId, 'mesh.idle_suspended', {
            agentId: args.projectMemberId ?? args.agentName,
            agentName: args.displayName ?? args.agentName,
            type: 'idle_suspended',
            payload: { meshSessionId: id, idleTimeoutMs }
          });
        } else if (
          resumePending &&
          snapshot.connection.state === 'connected' &&
          snapshot.activity.state !== 'suspended'
        ) {
          resumePending = false;
          this.ctx.events.emit(args.transcriptTargetId, 'mesh.idle_resumed', {
            agentId: args.projectMemberId ?? args.agentName,
            agentName: args.displayName ?? args.agentName,
            type: 'idle_resumed',
            payload: { meshSessionId: id }
          });
        }
        previousActivityState = snapshot.activity.state;
        if (managed) {
          this.ctx.getManagedProjectLoopEventHandler()?.({
            kind: 'runtime',
            sessionId: args.transcriptTargetId,
            meshSessionId: id,
            memberId: args.agentName,
            snapshot
          });
        }
        const updatedAt = new Date().toISOString();
        const terminal = snapshot.lifecycle.state === 'terminal' ? snapshot.lifecycle.termination : undefined;
        this.ctx.deps.store.upsertMeshSession({
          ...baseRow,
          state: terminal?.kind ?? (snapshot.lifecycle.state === 'active' ? 'running' : 'starting'),
          pid: snapshot.activity.state === 'running' ? snapshot.activity.pid : null,
          providerSessionRef: snapshot.providerSessionRef ?? null,
          exitCode: terminal?.kind === 'stopped' ? null : (terminal?.exitCode ?? null),
          updatedAt,
          exitedAt: terminal?.at ?? null
        });
        // Settle the owning binding on a provider-driven terminal (exited/failed) via a current-id CAS:
        // clear current + record terminal health only when the binding still points at THIS runtime, so a
        // superseded runtime's late exit is a no-op that cannot clear a replacement's current or overwrite
        // its health; the CAS also makes repeated snapshots idempotent. A 'stopped' terminal is excluded
        // (same as the terminalHandled branch below): explicit stops settle in MeshAgentHost.stop, and a
        // close during a start failure must let the catch record 'failed', not a 'stopped' close snapshot.
        if (terminal && terminal.kind !== 'stopped' && managed && args.projectMemberId) {
          this.ctx.deps.store.settleTerminalSessionBindingRuntime({
            sessionId: args.transcriptTargetId,
            projectMemberId: args.projectMemberId,
            terminatingRuntimeId: id,
            terminalState: terminal.kind,
            at: updatedAt
          });
        }
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
            reason: terminal?.kind ?? 'disconnected'
          });
        }
        if (terminal && terminal.kind !== 'stopped' && !terminalHandled) {
          terminalHandled = true;
          this.ctx.log.debug(
            {
              event: 'mesh.runtime.exited',
              sessionId: args.transcriptTargetId,
              memberId: args.projectMemberId ?? null,
              meshSessionId: id,
              runtimeGeneration: id,
              pid: lastPid,
              exitCode: terminal.exitCode ?? null,
              signal: terminal.signal ?? null,
              state: terminal.kind
            },
            'native cli exited'
          );
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
    let managedOwnershipEstablished = false;
    try {
      // Ownership MUST precede runtime.open: the initial turn can drive consumeEvent → the output
      // pipeline → a delivery cursor write before open resolves, and an unowned managed runtime is
      // fail-closed there. A managed start with no active binding fails here and is cleaned up below.
      if (willBeManaged) {
        this.establishManagedRuntimeOwnership(args, id);
        managedOwnershipEstablished = true;
      }
      await runtime.open(startInput?.initialTurn);
      const snapshot = runtime.snapshot();
      const terminal = snapshot.lifecycle.state === 'terminal' ? snapshot.lifecycle.termination : undefined;
      const pid = snapshot.activity.state === 'running' ? snapshot.activity.pid : null;
      const row: MeshSessionRow = {
        ...baseRow,
        state: terminal?.kind ?? 'running',
        pid,
        providerSessionRef: snapshot.providerSessionRef ?? null,
        exitCode: terminal?.exitCode ?? null,
        updatedAt: new Date().toISOString(),
        exitedAt: terminal?.at ?? null
      };
      this.ctx.deps.store.upsertMeshSession(row);
      if (!terminal) {
        this.ctx.log.debug(
          {
            event: 'mesh.runtime.started',
            sessionId: args.transcriptTargetId,
            memberId: args.projectMemberId ?? null,
            meshSessionId: id,
            runtimeGeneration: id,
            pid
          },
          'native cli started'
        );
        this.ctx.events.emit(args.transcriptTargetId, 'mesh.started', {
          meshSessionId: id,
          agentName: args.agentName,
          provider: agent.provider,
          productIcon: adapter.productIcon,
          workingPath,
          pid
        });
      }
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
      if (managedOwnershipEstablished) this.settleFailedManagedRuntime(args, id, failedAt);
      throw error;
    }
  }

  // Establish durable ownership of the just-created (still 'starting') runtime and point the member's
  // SessionBinding at it, through the single sanctioned entrance — synchronously, before the initial turn
  // opens. A managed runtime with no owner or no active binding is refused here (fail-closed): the caller's
  // catch marks the runtime failed and detaches, so no unowned managed runtime ever reaches the provider.
  private establishManagedRuntimeOwnership(args: MeshSessionEventRuntimeStartArgs, meshSessionId: string): void {
    const owner = args.projectMemberId;
    if (!owner) {
      throw new Error(`managed MeshAgent "${args.agentName}" start requires a project member owner`);
    }
    const binding = this.ctx.deps.store.getSessionBinding(args.transcriptTargetId, owner);
    if (binding?.lifecycle !== 'active') {
      throw new Error(`managed MeshAgent "${args.agentName}" has no active session binding to own its runtime`);
    }
    this.ctx.deps.store.replaceSessionBindingRuntime({
      sessionId: args.transcriptTargetId,
      projectMemberId: owner,
      currentNativeRuntimeSessionId: meshSessionId as MeshSessionId,
      updatedAt: new Date().toISOString()
    });
  }

  // A managed start that failed AFTER ownership was established (open threw): the runtime row is now
  // terminal, so settle it onto the binding through the SAME current-id CAS as any other terminal exit —
  // clear current + record 'failed' ONLY when the binding still points at exactly this runtime. It must not
  // re-claim the runtime first: during the catch's cleanup awaits a concurrent leave (current cleared) or a
  // replacement (current re-pointed at a NEW runtime) can intervene, and the CAS makes those a no-op, so the
  // failed OLD can never re-own current or overwrite the new health.
  private settleFailedManagedRuntime(args: MeshSessionEventRuntimeStartArgs, meshSessionId: string, at: string): void {
    const owner = args.projectMemberId;
    if (!owner) return;
    this.ctx.deps.store.settleTerminalSessionBindingRuntime({
      sessionId: args.transcriptTargetId,
      projectMemberId: owner,
      terminatingRuntimeId: meshSessionId,
      terminalState: 'failed',
      at
    });
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
