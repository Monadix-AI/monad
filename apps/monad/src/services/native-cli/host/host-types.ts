import type { MonadConfig } from '@monad/home';
import type {
  NativeCliAgentView,
  NativeCliHistoryPageRequest,
  NativeCliHistoryPageResponse,
  NativeCliLaunchMode,
  NativeCliObservationAccessResponse,
  NativeCliSessionView,
  TranscriptTargetId
} from '@monad/protocol';
import type { EventBus } from '@/services/event-bus.ts';
import type { BoundedOutputBuffer } from '@/services/native-cli/bounded-output-buffer.ts';
import type { NativeCliProcess, NativeCliStdin, NativeCliTerminal } from '@/services/native-cli/runtime-types.ts';
import type {
  NativeCliAppServerConnection,
  NativeCliInitializeContext,
  NativeCliLaunchSpec,
  NativeCliProviderAdapter
} from '@/services/native-cli/types.ts';
import type { Store } from '@/store/db/index.ts';

interface ManagedProjectOutput {
  sessionId: TranscriptTargetId;
  nativeCliSessionId: string;
  agentName: string;
  text: string;
  error?: boolean;
  post?: boolean;
}

export type ManagedProjectOutputHandler = (output: ManagedProjectOutput) => void | Promise<void>;
export type NativeCliObservationListener = (access: NativeCliObservationAccessResponse, done: boolean) => void;

export interface LiveNativeCliSession {
  id: string;
  transcriptTargetId: TranscriptTargetId;
  agentName: string;
  provider: NativeCliAgentView['provider'];
  runtimeRole: NativeCliSessionView['runtimeRole'];
  /** True when this managed session delegates provider approvals to the human (autopilot off + adapter
   *  can resolve). When false, leaked managed approvals are auto-denied (autopilot). */
  proxyApprovals: boolean;
  /** The long-lived child process. Absent for `cli-oneshot`, which spawns a fresh process per turn
   *  (see `oneshotTurnProc`) rather than keeping one alive for the session. */
  proc?: NativeCliProcess;
  adapter: NativeCliProviderAdapter;
  launchMode: NativeCliLaunchMode;
  terminal?: NativeCliTerminal;
  stdin?: NativeCliStdin;
  /** cli-oneshot only: the base launch spec (argv/env/cwd) reused for every per-turn spawn. */
  oneshotSpec?: NativeCliLaunchSpec;
  /** cli-oneshot only: the managed-project prompt, prepended to EVERY turn's directive (there is no
   *  session.start to carry it as developer instructions, and each turn is a stateless fresh process). */
  managedPrompt?: string | null;
  /** cli-oneshot only: the in-flight turn's process, so interrupt/stop can kill it. */
  oneshotTurnProc?: NativeCliProcess;
  /** cli-oneshot only: serializes turns so two concurrent deliveries (project fan-out + a user
   *  message) run one process at a time instead of racing/clobbering `oneshotTurnProc` + interleaving
   *  output into the shared buffer. */
  oneshotQueue?: Promise<void>;
  /** app-server frame channel, transport-neutral (stdio pipe or ws socket). Set once the chosen
   *  transport is connected; the adapter sends JSON-RPC frames through it. */
  appServer?: NativeCliAppServerConnection;
  /** Filesystem path of a `unix` app-server socket the daemon allocated, so it can be unlinked on
   *  teardown. Absent for stdio/ws. */
  appServerSocketPath?: string;
  /** Re-dial the app-server socket (ws port / unix path) after an unexpected drop. Absent for stdio
   *  (no socket) — a stdio drop means the child died, handled by `proc.exited`. */
  appServerRedial?: () => Promise<NativeCliAppServerConnection>;
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
  initializeContext?: NativeCliInitializeContext;
  providerSessionRef?: string | null;
  pendingApprovals: Map<string, Record<string, unknown>>;
  pendingHistoryPages: Map<
    string,
    {
      resolve(page: NativeCliHistoryPageResponse): void;
      reject(error: Error): void;
      request: NativeCliHistoryPageRequest;
      timeout: Timer;
    }
  >;
  startup?: {
    resolve(providerSessionRef: string): void;
    reject(error: Error): void;
    timeout: Timer;
  };
  /** In-memory tail-bounded output snapshot, flushed to SQLite on a timer (see scheduleSnapshotFlush)
   *  instead of read-modify-writing the 256 KB column on every output chunk. Chunk-list backed so a
   *  per-token append stays O(chunk), not O(buffer). */
  outputBuffer: BoundedOutputBuffer;
  /** Cumulative length of all output ever appended (monotonic, unbounded — unlike `outputBuffer`,
   *  which keeps only the tail). Serves as the observation cursor so the stream can push deltas. */
  outputSeq: number;
  snapshotFlushTimer: Timer | null;
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

export interface NativeCliHostDeps {
  store: Store;
  bus: EventBus;
  agents: () => Promise<NativeCliAgentView[]>;
  monadHome?: string;
  serverUrl?: string;
  /** Current daemon HTTPS switch. Used only when serverUrl is not supplied. Defaults to HTTPS on. */
  networkHttps?: MonadConfig['network']['https'];
  /** Resolve `${env:}`/`${secret:}` refs in an agent's env against fresh auth before spawn. When
   *  absent (tests) the env is used verbatim. */
  resolveAgentEnv?: (env?: Record<string, string>) => Promise<Record<string, string> | undefined>;
  nativeCliProcessRegistryPath?: string;
  authProcessRegistryPath?: string;
  authHeartbeatTimeoutMs?: number;
  /** Milliseconds before a resumable native CLI child is released while idle. <=0 disables it. */
  nativeCliIdleTimeoutMs?: number;
}
