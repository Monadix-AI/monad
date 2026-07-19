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

  async open(): Promise<SessionEventRuntimeSnapshot> {
    if (this.lifecycle.state !== 'starting') throw new Error('MeshAgent session runtime has already been opened');
    if (this.definition.plan.processModel === 'per-turn') {
      const ready = await this.definition.driver.openSession({
        workingPath: this.workingPath,
        ...(this.providerSessionRef ? { providerSessionRef: this.providerSessionRef } : {})
      });
      this.applyReady(ready);
      this.lifecycle = { state: 'active' };
      this.publishSnapshot();
      return this.snapshot();
    }
    const { plan, driver } = this.definition;
    this.connection = { state: 'connecting' };
    const launch = materializeProcessLaunch({
      executable: this.executable,
      allowedWorkingRoot: this.allowedWorkingRoot,
      plan: plan.launch
    });
    const epoch = this.createObservationEpoch();
    const abort = new AbortController();
    try {
      const activation = await this.withStartupTimeout(
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
      const ready = await driver.openSession({
        workingPath: this.workingPath,
        ...(this.providerSessionRef ? { providerSessionRef: this.providerSessionRef } : {})
      });
      this.applyReady(ready);
      const residentDriver = driver as Extract<
        SessionEventRuntimeDefinition,
        { plan: { processModel: 'resident' } }
      >['driver'];
      const attached = await residentDriver.attachChannel(activation.channel, {
        ...(this.providerSessionRef ? { providerSessionRef: this.providerSessionRef } : {})
      });
      if (attached) this.applyReady(attached);
      this.lifecycle = { state: 'active' };
      this.activity = { state: 'running', pid: activation.process.pid, queuedTurnCount: 0 };
      this.connection = { state: 'connected' };
      this.publishSnapshot();
      const packets = this.pumpPackets(activation, epoch, residentDriver);
      void this.monitorResident(activation, packets);
      return this.snapshot();
    } catch (error) {
      abort.abort();
      this.failSession(error);
      await this.disposeDriver();
      throw error;
    }
  }

  input(input: MeshAgentTurnInput): Promise<void> {
    if (this.lifecycle.state !== 'active') return Promise.reject(new Error('MeshAgent session is not active'));
    const parsed = meshAgentTurnInputSchema.parse(input);
    if (this.definition.plan.processModel === 'resident') {
      this.activity = {
        state: 'running',
        pid: this.activation?.process.pid ?? 0,
        queuedTurnCount: this.queuedTurnCount
      };
      this.publishSnapshot();
      const residentDriver = this.definition.driver as Extract<
        SessionEventRuntimeDefinition,
        { plan: { processModel: 'resident' } }
      >['driver'];
      return residentDriver.sendTurn(parsed);
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
      if (this.closePromise || this.lifecycle.state === 'terminal') return;
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
      if (!this.closePromise) this.failSession(error);
    }
  }

  private applyReady(ready: { capabilities: MeshAgentRuntimeCapabilities; providerSessionRef?: string }): void {
    this.capabilities = meshAgentRuntimeCapabilitiesSchema.parse(ready.capabilities);
    if (ready.providerSessionRef) this.setProviderSessionRef(ready.providerSessionRef);
  }

  private async consume(event: MeshAgentSessionEvent): Promise<void> {
    if (event.type === 'provider_session_identified') this.setProviderSessionRef(event.payload.providerSessionRef);
    await this.consumeEvent(event);
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
