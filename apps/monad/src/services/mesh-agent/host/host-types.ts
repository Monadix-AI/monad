import type { MonadConfig } from '@monad/environment';
import type { MeshAgentView, MeshSessionView } from '@monad/protocol';
import type { EventBus } from '#/services/event-bus.ts';
import type { LiveRawStore } from '#/services/mesh-agent/live-raw-store.ts';
import type { SessionEventRuntimeExecutor } from '#/services/mesh-agent/session-event-runtime/executor.ts';
import type { MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';
import type { Store } from '#/store/db/index.ts';
import type { MeshAgentTargetId } from '#/store/db/mesh-sessions.ts';

interface ManagedProjectOutput {
  sessionId: MeshAgentTargetId;
  meshSessionId: string;
  agentName: string;
  text: string;
  error?: boolean;
  post?: boolean;
}

export type ManagedProjectOutputHandler = (output: ManagedProjectOutput) => void | Promise<void>;
type MeshAgentObservationSignal = { state: 'live'; observationEpoch: string; seq: number } | { state: 'unavailable' };
export type MeshAgentObservationListener = (signal: MeshAgentObservationSignal, done: boolean) => void;

export interface LiveMeshSession {
  id: string;
  transcriptTargetId: MeshAgentTargetId;
  agentName: string;
  displayName?: string;
  provider: MeshAgentView['provider'];
  workingPath: string;
  runtimeRole: MeshSessionView['runtimeRole'];
  /** True when this managed session delegates provider approvals to the human (autopilot off + adapter
   *  can resolve). When false, leaked managed approvals are auto-denied (autopilot). */
  proxyApprovals: boolean;
  adapter: MeshAgentProviderAdapter;
  sessionEventRuntime?: SessionEventRuntimeExecutor;
  providerSessionRef?: string | null;
  pendingApprovals: Map<string, Record<string, unknown>>;
  liveRawStore: Pick<LiveRawStore, 'append' | 'closeAndDelete' | 'cursorBefore' | 'epoch' | 'page'>;
  observationEpoch: string;
  connectionOpen?: boolean;
  outputSeq: number;
  kill(signal?: NodeJS.Signals): void;
}

export interface MeshAgentHostDeps {
  store: Store;
  bus: EventBus;
  agents: () => Promise<MeshAgentView[]>;
  monadHome?: string;
  serverUrl?: string;
  /** Current daemon HTTPS switch. Used only when serverUrl is not supplied. Defaults to HTTPS on. */
  networkHttps?: MonadConfig['network']['https'];
  /** Resolve `${env:}`/`${secret:}` refs in an agent's env against fresh auth before spawn. When
   *  absent (tests) the env is used verbatim. */
  resolveAgentEnv?: (env?: Record<string, string>) => Promise<Record<string, string> | undefined>;
  meshAgentProcessRegistryPath?: string;
  meshAgentLiveStoreDirectory?: string;
  /** Developer mode installs the unredacted live fixture-capture tap. Never set outside developer mode. */
  developerMode?: boolean;
  meshFixtureCaptureDirectory?: string;
  authProcessRegistryPath?: string;
  authHeartbeatTimeoutMs?: number;
  authStatusTimeoutMs?: number;
}
