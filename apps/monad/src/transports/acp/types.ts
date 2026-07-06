import type { ToolBackends } from '@/capabilities/tools/types.ts';
import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';
import type { OpenDoc } from '@/transports/acp/documents.ts';

type DaemonHandlers = ReturnType<typeof createDaemonHandlers>;

/** The exact handler surface the ACP adapter touches. Derived (not redeclared) from the real
 * daemon handlers so it stays a single source of truth — yet narrow enough that an out-of-process
 * RPC **proxy** (transports/acp/bridge.ts) can satisfy it without reimplementing the whole daemon.
 * Both the in-process handlers and the bridge proxy are assignable to this. */
export type AcpHandlers = {
  session: Pick<
    DaemonHandlers['session'],
    | 'create'
    | 'get'
    | 'branch'
    | 'list'
    | 'messages'
    | 'delete'
    | 'abort'
    | 'sendInline'
    | 'restore'
    | 'provenance'
    | 'configureRuntime'
  >;
  commands: Pick<DaemonHandlers['commands'], 'list'>;
  oversight: Pick<DaemonHandlers['oversight'], 'approve'>;
  clarify: Pick<DaemonHandlers['clarify'], 'respond'>;
  delegation: Pick<DaemonHandlers['delegation'], 'respond' | 'output'>;
  model: Pick<
    DaemonHandlers['model'],
    'listProviders' | 'listModels' | 'listProfiles' | 'getDefaultProfile' | 'setDefaultProfile'
  >;
};

export type Handlers = AcpHandlers;

/** Per-session state the adapter tracks for the lifetime of one ACP connection. */
export interface AcpSession {
  /** Working directory from `session/new`; absolute per spec. */
  cwd: string;
  /** Set by `session/cancel` for the in-flight turn so `prompt` reports StopReason::Cancelled. */
  cancelled: boolean;
  /** Delegating fs/terminal backends when the client advertises the capability; absent → the
   * loop's default sandbox backend over the daemon disk. */
  backends?: ToolBackends;
  /** Drops daemon-host tools when this session delegates execution. */
  toolFilter?: (toolName: string) => boolean;
  /** Documents the editor has open in this session (uri → state), synced via `unstable_did*Document`
   * notifications and surfaced to the model as ambient context each turn. */
  openDocs: Map<string, OpenDoc>;
  /** The uri the editor most recently focused (rendered first / marked active in the context). */
  focusedUri?: string;
  /** Sandbox roots for this session = the client's cwd + additionalDirectories. ACP trusts the
   * client (it's user-controlled), so these REPLACE the daemon's roots for this session's fs/shell
   * (non-delegated paths); for delegated fs the editor owns the filesystem anyway. */
  sandboxRoots: string[];
}
