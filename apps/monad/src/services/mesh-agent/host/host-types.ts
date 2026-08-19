import type { MonadConfig } from '@monad/environment';
import type { MeshAgentSessionUsage, MeshAgentView, MeshSessionView } from '@monad/protocol';
import type { MeshAgentOutputEvent } from '@monad/sdk-atom';
import type { EventBus } from '#/services/event-bus.ts';
import type { LiveRawStore } from '#/services/mesh-agent/live-raw-store.ts';
import type { SessionEventRuntimeExecutor } from '#/services/mesh-agent/session-event-runtime/executor.ts';
import type {
  SessionEventRuntimeResourceFactory,
  SessionEventRuntimeSnapshot
} from '#/services/mesh-agent/session-event-runtime/types.ts';
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
export type MeshAgentApprovalMode = 'autopilot' | 'delegated' | 'interactive';
interface ManagedProjectLoopEventBase {
  sessionId: MeshAgentTargetId;
  meshSessionId: string;
  memberId: string;
}
type ManagedProjectLoopEvent = ManagedProjectLoopEventBase &
  ({ kind: 'output'; event: MeshAgentOutputEvent } | { kind: 'runtime'; snapshot: SessionEventRuntimeSnapshot });
export type ManagedProjectLoopEventHandler = (event: ManagedProjectLoopEvent) => void;
type MeshAgentObservationSignal = { state: 'live'; observationEpoch: string; seq: number } | { state: 'unavailable' };
export type MeshAgentObservationListener = (signal: MeshAgentObservationSignal, done: boolean) => void;
export type MeshAgentSessionUsageListener = (usage: MeshAgentSessionUsage) => void;

export interface LiveMeshSession {
  id: string;
  transcriptTargetId: MeshAgentTargetId;
  agentName: string;
  displayName?: string;
  provider: MeshAgentView['provider'];
  workingPath: string;
  runtimeRole: MeshSessionView['runtimeRole'];
  approvalMode: MeshAgentApprovalMode;
  adapter: MeshAgentProviderAdapter;
  sessionEventRuntime?: SessionEventRuntimeExecutor;
  providerSessionRef?: string | null;
  /** Provider-transcript position (`line:N`) at which this runtime's epoch began. The events/history
   *  pages are bounded by it so the transcript rows this epoch itself writes are never served as
   *  "earlier events" — the live plane is the sole authority for the epoch. Only set when the
   *  adapter's page cursors are actually line-formatted; absent otherwise (pages stay unbounded and
   *  the first-input trim below carries correctness). */
  providerEventsBoundary?: string;
  /** When this runtime's FIRST turn input was delivered. Transcript rows are stamped by the provider
   *  at accept time — always at/after delivery — so any history event from the first user prompt at
   *  or after this instant is the live epoch's own content and is dropped from history pages. */
  epochFirstInputAt?: string;
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
  /** Resolve environment refs in an agent's env before spawn. When
   *  absent (tests) the env is used verbatim. */
  resolveAgentEnv?: (env?: Record<string, string>) => Promise<Record<string, string> | undefined>;
  meshAgentProcessRegistryPath?: string;
  meshAgentLiveStoreDirectory?: string;
  /** Developer mode installs the unredacted live fixture-capture tap. Never set outside developer mode. */
  developerMode?: boolean;
  meshFixtureCaptureDirectory?: string;
  meshLiveEventLogsDirectory?: string;
  authProcessRegistryPath?: string;
  authHeartbeatTimeoutMs?: number;
  authStatusTimeoutMs?: number;
  /** Override the session-event runtime resource factory. Absent in production (a real Bun-spawn factory is
   *  built per start); injected by tests to drive deterministic runtime lifecycles without a real process. */
  resourceFactory?: SessionEventRuntimeResourceFactory;
}
