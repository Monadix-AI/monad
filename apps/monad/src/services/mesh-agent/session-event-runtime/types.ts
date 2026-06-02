import type {
  MeshAgentRuntimeCapabilities,
  MeshConnectionCondition,
  MeshExecutionActivity,
  MeshSessionLifecycle
} from '@monad/protocol';
import type {
  MeshAgentSessionEvent,
  SessionEventChannel,
  SessionEventChannelPlan,
  SessionEventPacket,
  TurnProcessResult
} from '@monad/sdk-atom';
import type { MaterializedProcessLaunch } from './launch.ts';

interface SessionEventRuntimeProcess {
  pid: number;
  result: Promise<TurnProcessResult>;
  writeStdin?(bytes: Uint8Array): Promise<void>;
  closeStdin?(): Promise<void>;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

export interface SessionEventRuntimeActivation {
  process: SessionEventRuntimeProcess;
  channel: SessionEventChannel;
  packets(): AsyncIterable<SessionEventPacket>;
  close(): Promise<void>;
}

export interface SessionEventRuntimeStartRequest {
  launch: MaterializedProcessLaunch;
  channel: SessionEventChannelPlan;
  startupTimeoutMs: number;
  observationEpoch: string;
  signal: AbortSignal;
}

export interface SessionEventRuntimeResourceFactory {
  start(request: SessionEventRuntimeStartRequest): Promise<SessionEventRuntimeActivation>;
}

export interface SessionEventRuntimeSnapshot {
  lifecycle: MeshSessionLifecycle;
  activity: MeshExecutionActivity;
  connection: MeshConnectionCondition;
  capabilities: MeshAgentRuntimeCapabilities;
  providerSessionRef?: string;
}

export interface SessionEventRuntimeCallbacks {
  captureRaw(packet: SessionEventPacket, observationEpoch: string): Promise<void>;
  consumeEvent(event: MeshAgentSessionEvent): Promise<void>;
  onSnapshot?(snapshot: SessionEventRuntimeSnapshot): void;
}
