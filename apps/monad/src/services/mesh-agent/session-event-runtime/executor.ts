import type {
  MeshAgentApprovalResolutionRequest,
  MeshAgentRuntimeCapabilities,
  MeshAgentTurnInput,
  MeshConnectionCondition,
  MeshExecutionActivity,
  MeshSessionLifecycle
} from '@monad/protocol';
import type { MeshAgentProviderDriver, MeshAgentSessionEvent, SessionEventRuntimeDefinition } from '@monad/sdk-atom';
import type {
  SessionEventRuntimeActivation,
  SessionEventRuntimeCallbacks,
  SessionEventRuntimeResourceFactory,
  SessionEventRuntimeSnapshot
} from './types.ts';

import { meshAgentRuntimeCapabilitiesSchema, meshAgentTurnInputSchema } from '@monad/protocol';

import { BoundedSessionEventIngress } from './event-sink.ts';
import { materializeProcessLaunch, materializeTurnLaunch } from './launch.ts';
import { validateProcessLaunchPlan, validateSessionEventRuntimeDefinition } from './validation.ts';

const NO_CAPABILITIES: MeshAgentRuntimeCapabilities = {
  input: false,
  steer: false,
  interrupt: false,
  approvalResolution: false,
  providerSessionContinuation: false,
  runtimeRestoration: false,
  sessionReopen: false
};

interface SessionEventRuntimeExecutorOptions extends SessionEventRuntimeCallbacks {
  definition: SessionEventRuntimeDefinition;
  executable: string;
  allowedWorkingRoot: string;
  workingPath: string;
  providerSessionRef?: string;
  resourceFactory: SessionEventRuntimeResourceFactory;
  createObservationEpoch(): string;
}

function runtimeFailure(message: string, retryable: boolean) {
  return { code: 'session_event_runtime_failed', message, retryable };
}

export class SessionEventRuntimeExecutor {
  private readonly definition: SessionEventRuntimeDefinition;
  private readonly executable: string;
  private readonly allowedWorkingRoot: string;
  private readonly workingPath: string;
  private readonly resourceFactory: SessionEventRuntimeResourceFactory;
  private readonly createObservationEpoch: () => string;
  private readonly captureRaw: SessionEventRuntimeCallbacks['captureRaw'];
  private readonly consumeEvent: SessionEventRuntimeCallbacks['consumeEvent'];
  private readonly onSnapshot?: SessionEventRuntimeCallbacks['onSnapshot'];
  private readonly ingress: BoundedSessionEventIngress;
  private lifecycle: MeshSessionLifecycle = { state: 'starting' };
  private activity: MeshExecutionActivity = { state: 'idle', pid: null, queuedTurnCount: 0 };
  private connection: MeshConnectionCondition = { state: 'inactive' };
  private capabilities: MeshAgentRuntimeCapabilities = NO_CAPABILITIES;
  private providerSessionRef?: string;
  private activation?: SessionEventRuntimeActivation;
  private turnTail: Promise<void> = Promise.resolve();
  private queuedTurnCount = 0;
  private closePromise?: Promise<void>;
  private disposed = false;
  private turnSequence = 0;
  private residentActivationPromise?: Promise<void>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly intentionallyClosedActivations = new WeakSet<SessionEventRuntimeActivation>();

  constructor(options: SessionEventRuntimeExecutorOptions) {
    this.definition = validateSessionEventRuntimeDefinition(options.definition);
    this.executable = options.executable;
    this.allowedWorkingRoot = options.allowedWorkingRoot;
    this.workingPath = options.workingPath;
    this.resourceFactory = options.resourceFactory;
    this.createObservationEpoch = options.createObservationEpoch;
    this.captureRaw = options.captureRaw;
    this.consumeEvent = options.consumeEvent;
    this.onSnapshot = options.onSnapshot;
    this.providerSessionRef = options.providerSessionRef;
    this.ingress = new BoundedSessionEventIngress({
      consume: (event) => this.consume(event),
      onCancel: (error) => {
        if (this.definition.plan.processModel === 'resident') this.failSession(error);
      }
    });
  }

  snapshot(): SessionEventRuntimeSnapshot {
    return {
      lifecycle: this.lifecycle,
      activity: this.activity,
      connection: this.connection,
      capabilities: this.capabilities,
      ...(this.providerSessionRef ? { providerSessionRef: this.providerSessionRef } : {})
    };
  }

  async open(initialTurn?: MeshAgentTurnInput): Promise<SessionEventRuntimeSnapshot> {
    if (this.lifecycle.state !== 'starting') throw new Error('MeshAgent session runtime has already been opened');
    if (this.definition.plan.processModel === 'per-turn') {
      const ready = await this.definition.driver.openSession({
        workingPath: this.workingPath,
        ...(this.providerSessionRef ? { providerSessionRef: this.providerSessionRef } : {})
      });
      this.applyReady(ready);
      this.lifecycle = { state: 'active' };
      this.publishSnapshot();
      if (initialTurn) await this.input(initialTurn);
      return this.snapshot();
    }
    const { driver } = this.definition;
    try {
      const ready = await driver.openSession({
        workingPath: this.workingPath,
        ...(this.providerSessionRef ? { providerSessionRef: this.providerSessionRef } : {})
      });
      this.applyReady(ready);
      await this.ensureResidentActive();
      this.lifecycle = { state: 'active' };
      this.publishSnapshot();
      if (initialTurn) await this.input(initialTurn);
      else this.armIdleTimer();
      return this.snapshot();
    } catch (error) {
      this.failSession(error);
      await this.disposeDriver();
      throw error;
    }
  }

  input(input: MeshAgentTurnInput): Promise<void> {
    if (this.lifecycle.state !== 'active') return Promise.reject(new Error('MeshAgent session is not active'));
    const parsed = meshAgentTurnInputSchema.parse(input);
    if (this.definition.plan.processModel === 'resident') {
      this.clearIdleTimer();
      return this.ensureResidentActive().then(async () => {
        const activation = this.activation;
        if (!activation) throw new Error('MeshAgent resident session failed to activate');
        this.activity = {
          state: 'running',
          pid: activation.process.pid,
          queuedTurnCount: this.queuedTurnCount
        };
        this.publishSnapshot();
        try {
          await this.residentDriver().sendTurn(parsed);
        } catch (error) {
          this.settleResidentActivity();
          throw error;
        }
      });
    }
    this.queuedTurnCount += 1;
    this.updateQueuedActivity();
    const job = this.turnTail.then(() => this.runTurn(parsed));
    this.turnTail = job.catch(() => {});
    return job;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  async interrupt(): Promise<void> {
    const control = this.definition.driver.controls.interrupt;
    if (!control) throw new Error('MeshAgent session runtime does not support interrupt');
    await control.run();
    this.settleResidentActivity();
  }

  async steer(input: MeshAgentTurnInput): Promise<void> {
    const control = this.definition.driver.controls.steer;
    if (!control) throw new Error('MeshAgent session runtime does not support steering');
    await control.send(meshAgentTurnInputSchema.parse(input));
  }

  async resolveApproval(resolution: MeshAgentApprovalResolutionRequest): Promise<void> {
    const control = this.definition.driver.controls.approvalResolution;
    if (!control) throw new Error('MeshAgent session runtime does not support approval resolution');
    await control.resolve(resolution);
  }

  private async runTurn(input: MeshAgentTurnInput): Promise<void> {
    if (this.definition.plan.processModel !== 'per-turn') return;
    const { plan } = this.definition;
    const driver = this.definition.driver as Extract<
      SessionEventRuntimeDefinition,
      { plan: { processModel: 'per-turn' } }
    >['driver'];
    this.queuedTurnCount = Math.max(0, this.queuedTurnCount - 1);
    this.activity = { state: 'starting', pid: null, queuedTurnCount: this.queuedTurnCount };
    this.connection = { state: 'connecting' };
    this.publishSnapshot();
    const processPlan = validateProcessLaunchPlan(
      plan.buildTurnLaunch({ ...(this.providerSessionRef ? { providerSessionRef: this.providerSessionRef } : {}) })
    );
    const launch = materializeTurnLaunch({
      executable: this.executable,
      allowedWorkingRoot: this.allowedWorkingRoot,
      plan: processPlan,
      input: plan.encodeTurnInput(input)
    });
    const epoch = this.createObservationEpoch();
    const abort = new AbortController();
    let activation: SessionEventRuntimeActivation | undefined;
    try {
      activation = await this.withStartupTimeout(
        this.resourceFactory.start({
          launch,
          channel: { kind: 'child-stdio' },
          startupTimeoutMs: plan.startup.timeoutMs,
          observationEpoch: epoch,
          signal: abort.signal
        }),
        plan.startup.timeoutMs,
        abort
      );
      this.activation = activation;
      this.activity = { state: 'running', pid: activation.process.pid, queuedTurnCount: this.queuedTurnCount };
      this.connection = { state: 'connected' };
      this.publishSnapshot();
      await driver.attachTurnChannel(activation.channel, {
        turnId: `turn-${++this.turnSequence}`,
        ...(this.providerSessionRef ? { providerSessionRef: this.providerSessionRef } : {})
      });
      if (launch.stdin) {
        if (!activation.process.writeStdin) throw new Error('turn process does not expose stdin');
        await activation.process.writeStdin(launch.stdin);
        await activation.process.closeStdin?.();
      }
      const [result] = await Promise.all([activation.process.result, this.pumpPackets(activation, epoch, driver)]);
      await driver.completeTurn(result);
      if (result.failure) throw new Error(result.failure.message);
      if (result.exitCode !== 0)
        throw new Error(`MeshAgent turn process exited with code ${result.exitCode ?? 'unknown'}`);
    } finally {
      abort.abort();
      await activation?.close();
      if (this.activation === activation) this.activation = undefined;
      if (this.lifecycle.state === 'active') {
        this.connection = { state: 'inactive' };
        this.activity =
          this.queuedTurnCount === 0
            ? { state: 'idle', pid: null, queuedTurnCount: 0 }
            : { state: 'starting', pid: null, queuedTurnCount: this.queuedTurnCount };
        this.publishSnapshot();
      }
    }
  }

  private async pumpPackets(
    activation: SessionEventRuntimeActivation,
    epoch: string,
    driver: MeshAgentProviderDriver
  ): Promise<void> {
    for await (const packet of activation.packets()) {
      await this.captureRaw(packet, epoch);
      await this.ingress.ingest(packet, (next, sink) => driver.accept(next, sink));
    }
  }

  private async monitorResident(activation: SessionEventRuntimeActivation, packets: Promise<void>): Promise<void> {
    try {
      const [result] = await Promise.all([activation.process.result, packets]);
      if (
        this.closePromise ||
        this.lifecycle.state === 'terminal' ||
        this.intentionallyClosedActivations.has(activation)
      )
        return;
      await activation.close();
      await this.disposeDriver();
      const at = new Date().toISOString();
      this.connection = { state: 'inactive' };
      this.activity = { state: 'idle', pid: null, queuedTurnCount: 0 };
      this.lifecycle = {
        state: 'terminal',
        termination: {
          kind: 'failed',
          at,
          exitCode: result.exitCode,
          error: result.failure ?? runtimeFailure(`resident process exited with code ${result.exitCode}`, false)
        }
      };
      this.publishSnapshot();
    } catch (error) {
      if (!this.closePromise && !this.intentionallyClosedActivations.has(activation)) this.failSession(error);
    }
  }

  private applyReady(ready: { capabilities: MeshAgentRuntimeCapabilities; providerSessionRef?: string }): void {
    this.capabilities = meshAgentRuntimeCapabilitiesSchema.parse(ready.capabilities);
    if (ready.providerSessionRef) this.setProviderSessionRef(ready.providerSessionRef);
  }

  private async consume(event: MeshAgentSessionEvent): Promise<void> {
    if (event.type === 'provider_session_identified') this.setProviderSessionRef(event.payload.providerSessionRef);
    await this.consumeEvent(event);
    if (
      (event.type === 'agent_message' && event.payload.final === true) ||
      event.type === 'provider_error' ||
      event.type === 'connection_required'
    )
      this.settleResidentActivity();
  }

  private settleResidentActivity(): void {
    if (this.definition.plan.processModel !== 'resident' || this.lifecycle.state !== 'active') return;
    this.activity = { state: 'idle', pid: null, queuedTurnCount: 0 };
    this.publishSnapshot();
    this.armIdleTimer();
  }

  private setProviderSessionRef(next: string): void {
    if (this.providerSessionRef && this.providerSessionRef !== next) {
      throw new Error('provider session identity changed during a logical session');
    }
    this.providerSessionRef = next;
    this.publishSnapshot();
  }

  private updateQueuedActivity(): void {
    if (this.activity.state === 'idle') return;
    this.activity = { ...this.activity, queuedTurnCount: this.queuedTurnCount } as MeshExecutionActivity;
    this.publishSnapshot();
  }

  private failSession(error: unknown): void {
    if (this.lifecycle.state === 'terminal') return;
    this.clearIdleTimer();
    const message = error instanceof Error ? error.message : String(error);
    this.lifecycle = {
      state: 'terminal',
      termination: { kind: 'failed', at: new Date().toISOString(), error: runtimeFailure(message, false) }
    };
    this.activity = { state: 'idle', pid: null, queuedTurnCount: 0 };
    this.connection = { state: 'inactive' };
    this.publishSnapshot();
  }

  private async closeOnce(): Promise<void> {
    this.clearIdleTimer();
    if (this.lifecycle.state !== 'terminal') {
      this.lifecycle = { state: 'terminal', termination: { kind: 'stopped', at: new Date().toISOString() } };
    }
    this.activity = { state: 'idle', pid: null, queuedTurnCount: 0 };
    this.connection = { state: 'inactive' };
    this.publishSnapshot();
    const activation = this.activation;
    this.activation = undefined;
    if (activation) {
      await activation.process.kill('SIGTERM');
      await activation.close();
    }
    await this.disposeDriver();
  }

  private residentDriver(): Extract<SessionEventRuntimeDefinition, { plan: { processModel: 'resident' } }>['driver'] {
    if (this.definition.plan.processModel !== 'resident') {
      throw new Error('MeshAgent session runtime is not resident');
    }
    return this.definition.driver as Extract<
      SessionEventRuntimeDefinition,
      { plan: { processModel: 'resident' } }
    >['driver'];
  }

  private ensureResidentActive(): Promise<void> {
    if (this.activation) return Promise.resolve();
    this.residentActivationPromise ??= this.activateResident().finally(() => {
      this.residentActivationPromise = undefined;
    });
    return this.residentActivationPromise;
  }

  private async activateResident(): Promise<void> {
    if (this.definition.plan.processModel !== 'resident') return;
    const { plan } = this.definition;
    this.connection = { state: 'connecting' };
    this.activity = { state: 'starting', pid: null, queuedTurnCount: this.queuedTurnCount };
    this.publishSnapshot();
    const processPlan = plan.buildLaunch
      ? plan.buildLaunch({
          ...(this.providerSessionRef ? { providerSessionRef: this.providerSessionRef } : {})
        })
      : plan.launch;
    const launch = materializeProcessLaunch({
      executable: this.executable,
      allowedWorkingRoot: this.allowedWorkingRoot,
      plan: validateProcessLaunchPlan(processPlan)
    });
    const epoch = this.createObservationEpoch();
    const abort = new AbortController();
    let activation: SessionEventRuntimeActivation | undefined;
    try {
      activation = await this.withStartupTimeout(
        this.resourceFactory.start({
          launch,
          channel: plan.channel,
          startupTimeoutMs: plan.startup.timeoutMs,
          observationEpoch: epoch,
          signal: abort.signal
        }),
        plan.startup.timeoutMs,
        abort
      );
      this.activation = activation;
      const packets = this.pumpPackets(activation, epoch, this.residentDriver());
      void this.monitorResident(activation, packets);
      const attached = await this.withStartupTimeout(
        this.residentDriver().attachChannel(activation.channel, {
          ...(this.providerSessionRef ? { providerSessionRef: this.providerSessionRef } : {})
        }),
        plan.startup.timeoutMs,
        abort
      );
      if (attached) this.applyReady(attached);
      this.connection = { state: 'connected' };
      this.activity = { state: 'idle', pid: null, queuedTurnCount: 0 };
      this.publishSnapshot();
    } catch (error) {
      abort.abort();
      if (activation) {
        this.intentionallyClosedActivations.add(activation);
        if (this.activation === activation) this.activation = undefined;
        await activation.process.kill('SIGTERM');
        await activation.close();
      }
      throw error;
    }
  }

  private armIdleTimer(): void {
    if (this.definition.plan.processModel !== 'resident' || !this.definition.plan.suspend) return;
    this.clearIdleTimer();
    const { idleTimeoutMs } = this.definition.plan.suspend;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.suspendResident();
    }, idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async suspendResident(): Promise<void> {
    if (
      this.definition.plan.processModel !== 'resident' ||
      this.lifecycle.state !== 'active' ||
      this.activity.state !== 'idle'
    )
      return;
    const activation = this.activation;
    if (!activation) return;
    this.activation = undefined;
    this.intentionallyClosedActivations.add(activation);
    this.connection = { state: 'inactive' };
    this.activity = {
      state: 'suspended',
      pid: null,
      suspendedAt: new Date().toISOString(),
      queuedTurnCount: 0
    };
    this.publishSnapshot();
    await activation.process.kill('SIGTERM');
    await activation.close();
  }

  private async disposeDriver(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.definition.driver.dispose();
  }

  private publishSnapshot(): void {
    this.onSnapshot?.(this.snapshot());
  }

  private async withStartupTimeout<T>(promise: Promise<T>, timeoutMs: number, abort: AbortController): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error(`MeshAgent session runtime startup timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
