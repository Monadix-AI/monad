import type { MonadConfig } from '@monad/environment';
import type {
  ExternalAgentLaunchMode,
  ExternalAgentObservationAccessResponse,
  ExternalAgentSessionView,
  ExternalAgentView
} from '@monad/protocol';
import type { EventBus } from '#/services/event-bus.ts';
import type { LiveRawStore } from '#/services/external-agent/live-raw-store.ts';
import type {
  ExternalAgentProcess,
  ExternalAgentStdin,
  ExternalAgentTerminal
} from '#/services/external-agent/runtime-types.ts';
import type {
  ExternalAgentAppServerConnection,
  ExternalAgentInitializeContext,
  ExternalAgentLaunchSpec,
  ExternalAgentProviderAdapter
} from '#/services/external-agent/types.ts';
import type { ExternalAgentTargetId } from '#/store/db/external-agent-sessions.ts';
import type { Store } from '#/store/db/index.ts';

interface ManagedProjectOutput {
  sessionId: ExternalAgentTargetId;
  externalAgentSessionId: string;
  agentName: string;
  text: string;
  error?: boolean;
  post?: boolean;
}

export type ManagedProjectOutputHandler = (output: ManagedProjectOutput) => void | Promise<void>;
export type ExternalAgentObservationListener = (access: ExternalAgentObservationAccessResponse, done: boolean) => void;

export interface LiveExternalAgentSession {
  id: string;
  transcriptTargetId: ExternalAgentTargetId;
  agentName: string;
  displayName?: string;
  provider: ExternalAgentView['provider'];
  runtimeRole: ExternalAgentSessionView['runtimeRole'];
  /** True when this managed session delegates provider approvals to the human (autopilot off + adapter
   *  can resolve). When false, leaked managed approvals are auto-denied (autopilot). */
  proxyApprovals: boolean;
  /** The long-lived child process. Absent for `cli-oneshot`, which spawns a fresh process per turn
   *  (see `oneshotTurnProc`) rather than keeping one alive for the session. */
  proc?: ExternalAgentProcess;
  adapter: ExternalAgentProviderAdapter;
  launchMode: ExternalAgentLaunchMode;
  terminal?: ExternalAgentTerminal;
  stdin?: ExternalAgentStdin;
  /** cli-oneshot only: the base launch spec (argv/env/cwd) reused for every per-turn spawn. */
  oneshotSpec?: ExternalAgentLaunchSpec;
  /** cli-oneshot only: the managed-project prompt, prepended to EVERY turn's directive (there is no
   *  session.start to carry it as developer instructions, and each turn is a stateless fresh process). */
  managedPrompt?: string | null;
  /** cli-oneshot only: the in-flight turn's process, so interrupt/stop can kill it. */
  oneshotTurnProc?: ExternalAgentProcess;
  /** cli-oneshot only: serializes turns so two concurrent deliveries (project fan-out + a user
   *  message) run one process at a time instead of racing/clobbering `oneshotTurnProc` + interleaving
   *  output into the shared buffer. */
  oneshotQueue?: Promise<void>;
  /** app-server frame channel, transport-neutral (stdio pipe or ws socket). Set once the chosen
   *  transport is connected; the adapter sends JSON-RPC frames through it. */
  appServer?: ExternalAgentAppServerConnection;
  /** Filesystem path of a `unix` app-server socket the daemon allocated, so it can be unlinked on
   *  teardown. Absent for stdio/ws. */
  appServerSocketPath?: string;
  /** Re-dial the app-server socket (ws port / unix path) after an unexpected drop. Absent for stdio
   *  (no socket) — a stdio drop means the child died, handled by `proc.exited`. */
  appServerRedial?: () => Promise<ExternalAgentAppServerConnection>;
  /** Guards against overlapping reconnect attempts. */
  appServerReconnecting?: boolean;
  /** Cumulative app-server disconnect→redial cycles in the current unstable streak. `reconnectAppServer`
   *  declares success (and resets its own bounded attempt counter) the moment the socket TRANSPORT
   *  reopens — before the app-level handshake completes — so a gateway that keeps reopening the socket
   *  and then rejecting the handshake would otherwise reconnect forever with no per-invocation counter
   *  ever exhausting. This field is the cross-invocation cap that closes that gap; see
   *  `APP_SERVER_MAX_DISCONNECT_CYCLES`. */
  appServerDisconnectCycles?: number;
  /** Clears `appServerDisconnectCycles` once a reconnected socket survives `APP_SERVER_RECONNECT_STREAK_RESET_MS`
   *  without dropping again — a fresh disconnect cancels this timer so a genuinely unstable gateway can't
   *  reset its own cycle count by surviving just long enough between drops. */
  appServerStreakResetTimer?: Timer;
  /** The initialize context, retained so a reconnect can re-establish the thread via `thread/resume`. */
  initializeContext?: ExternalAgentInitializeContext;
  providerSessionRef?: string | null;
  pendingApprovals: Map<string, Record<string, unknown>>;
  pendingHistoryPages: Map<
    string,
    {
      resolve(page: { items: unknown[]; nextCursor?: string }): void;
      reject(error: Error): void;
      timeout: Timer;
    }
  >;
  startup?: {
    resolve(providerSessionRef: string): void;
    reject(error: Error): void;
    timeout: Timer;
  };
  liveRawStore: Pick<LiveRawStore, 'append' | 'closeAndDelete' | 'cursorBefore' | 'page' | 'parseCursor'>;
  observationEpoch: string;
  observationEpochReady?: boolean;
  observationEpochPreparation?: Promise<void>;
  /** True while an `external_agent.session.connection.opened` has fired for the current epoch without a
   *  matching `closed` — makes the open/close emit idempotent so a late teardown can't double-close. */
  connectionOpen?: boolean;
  providerHistoryCheckpoint?: string;
  providerHistoryIdentities?: Set<string>;
  /** Last committed raw-store row sequence in the current observation epoch. */
  outputSeq: number;
  /** JSON-RPC request→kind ledger for app-server sessions: the adapter records what each outbound
   *  request id was for so a response can be dispatched by id rather than by guessing its shape. */
  pendingRequests: Map<string | number, string>;
  nextRequestId(): number;
  /** Non-PTY resumable sessions can release their child process while idle and restore it on input. */
  idleTimer?: Timer;
  idleTimeoutMs?: number;
  suspended?: boolean;
  restartRuntime?: () => Promise<void>;
  resumeQueue?: Promise<void>;
  kill(signal?: NodeJS.Signals): void;
}

export interface ExternalAgentHostDeps {
  store: Store;
  bus: EventBus;
  agents: () => Promise<ExternalAgentView[]>;
  monadHome?: string;
  serverUrl?: string;
  /** Current daemon HTTPS switch. Used only when serverUrl is not supplied. Defaults to HTTPS on. */
  networkHttps?: MonadConfig['network']['https'];
  /** Resolve `${env:}`/`${secret:}` refs in an agent's env against fresh auth before spawn. When
   *  absent (tests) the env is used verbatim. */
  resolveAgentEnv?: (env?: Record<string, string>) => Promise<Record<string, string> | undefined>;
  externalAgentProcessRegistryPath?: string;
  externalAgentLiveStoreDirectory?: string;
  authProcessRegistryPath?: string;
  authHeartbeatTimeoutMs?: number;
  authStatusTimeoutMs?: number;
  /** Milliseconds before a resumable external agent child is released while idle. <=0 disables it. */
  externalAgentIdleTimeoutMs?: number;
  /** Base delay for app-server reconnect backoff. Defaults to the production retry policy. */
  appServerReconnectBaseMs?: number;
  /** Grace before treating an app-server disconnect as recoverable transport loss. */
  appServerDisconnectGraceMs?: number;
}
