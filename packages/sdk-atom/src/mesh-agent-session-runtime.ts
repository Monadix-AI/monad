import type {
  MeshAgentApprovalResolutionRequest,
  MeshAgentRuntimeCapabilities,
  MeshAgentRuntimeFailure,
  MeshAgentTurnInput
} from '@monad/protocol';
import type { MeshAgentOutputEvent } from './agent-adapter.ts';

export type SessionEventChannelPlan =
  | { kind: 'child-stdio' }
  | { kind: 'websocket'; endpoint: 'daemon-loopback' }
  | { kind: 'unix-socket'; endpoint: 'daemon-runtime' };

export interface MeshAgentProcessLaunchPlan {
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
}

export interface StartupPolicy {
  timeoutMs: number;
}

export interface ReconnectPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface SuspendPolicy {
  idleTimeoutMs: number;
}

export type EncodedTurnInput =
  | { delivery: 'stdin'; bytes: Uint8Array }
  | { delivery: 'argv-tail'; separator: '--'; values: readonly string[] };

export interface ResidentSessionEventPlan {
  processModel: 'resident';
  launch: MeshAgentProcessLaunchPlan;
  channel: SessionEventChannelPlan;
  startup: StartupPolicy;
  reconnect?: ReconnectPolicy;
  suspend?: SuspendPolicy;
}

export interface PerTurnSessionEventPlan {
  processModel: 'per-turn';
  buildTurnLaunch(context: { providerSessionRef?: string }): MeshAgentProcessLaunchPlan;
  encodeTurnInput(input: MeshAgentTurnInput): EncodedTurnInput;
  startup: StartupPolicy;
  continuation: { strategy: 'provider-session-ref' };
}

export type SessionEventRuntimePlan = ResidentSessionEventPlan | PerTurnSessionEventPlan;

export interface SessionEventPacket {
  bytes: Uint8Array;
  source: 'provider-channel' | 'stdout' | 'stderr';
  receivedAt: string;
}

export type MeshAgentSessionEvent =
  | MeshAgentOutputEvent
  | {
      type: 'provider_session_identified';
      payload: { providerSessionRef: string };
    };

export interface MeshAgentEventSink {
  emit(event: MeshAgentSessionEvent): Promise<void>;
}

export interface SessionEventChannel {
  send(frame: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface DriverContext {
  workingPath: string;
  providerSessionRef?: string;
}

export interface SessionEventChannelContext {
  providerSessionRef?: string;
}

export interface TurnChannelContext extends SessionEventChannelContext {
  turnId: string;
}

export interface DriverReady {
  capabilities: MeshAgentRuntimeCapabilities;
  providerSessionRef?: string;
}

export interface TurnProcessResult {
  exitCode: number | null;
  signal?: NodeJS.Signals;
  failure?: MeshAgentRuntimeFailure;
}

export interface ProviderDriverControls {
  approvalResolution: false | { resolve(resolution: MeshAgentApprovalResolutionRequest): Promise<void> };
  steer: false | { send(input: MeshAgentTurnInput): Promise<void> };
  interrupt: false | { run(): Promise<void> };
}

export interface ProviderDriverBase {
  controls: ProviderDriverControls;
  openSession(context: DriverContext): Promise<DriverReady>;
  accept(packet: SessionEventPacket, sink: MeshAgentEventSink): Promise<void>;
  dispose(): Promise<void>;
}

export interface ResidentProviderDriver extends ProviderDriverBase {
  processModel: 'resident';
  attachChannel(channel: SessionEventChannel, context: SessionEventChannelContext): Promise<DriverReady | undefined>;
  sendTurn(input: MeshAgentTurnInput): Promise<void>;
}

export interface PerTurnProviderDriver extends ProviderDriverBase {
  processModel: 'per-turn';
  attachTurnChannel(channel: SessionEventChannel, context: TurnChannelContext): Promise<void>;
  completeTurn(result: TurnProcessResult): Promise<void>;
}

export type MeshAgentProviderDriver = ResidentProviderDriver | PerTurnProviderDriver;

export type SessionEventRuntimeDefinition =
  | { plan: ResidentSessionEventPlan; driver: ResidentProviderDriver }
  | { plan: PerTurnSessionEventPlan; driver: PerTurnProviderDriver };
