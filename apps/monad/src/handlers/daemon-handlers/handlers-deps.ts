import type { MonadPaths, ObscuraConfig } from '@monad/home';
import type { Logger } from '@monad/logger';
import type {
  GetLawsResponse,
  GetMem0DataResponse,
  IndexerStatus,
  McpServerStatus,
  MemoryBackendId,
  SetMem0ModelsRequest,
  SetMemoryGraphRequest,
  SkillListInstance,
  SkillListItem
} from '@monad/protocol';
import type { WorkspaceExperienceApiHandler } from '@monad/sdk-atom';
import type { AtomConflict } from '@/atoms/resolve.ts';
import type { ChannelService } from '@/channels/channel.ts';
import type { SessionDeps } from '@/handlers/session/index.ts';
import type { ModelDeps } from '@/handlers/settings/model/index.ts';
import type { ConfigBus } from '@/services/config-bus.ts';
import type { ClarifyService } from '@/services/generation/clarify.ts';
import type { I18nService } from '@/services/i18n.ts';
import type { KvService } from '@/services/kv.ts';
import type { L2Provider } from '@/services/memory/graph/types.ts';
import type { MemoryService } from '@/services/memory/index.ts';
import type { OversightService } from '@/services/oversight.ts';

export interface DaemonHandlerDeps extends SessionDeps, ModelDeps {
  // SessionDeps types `paths` as the narrow `{ config }?` while ModelDeps needs the full
  // MonadPaths; re-declare it here (the daemon always passes the full paths) so extending
  // both does not collide.
  paths: MonadPaths;
  /** Layered L1 memory service — backs the memory control API. */
  memoryService: MemoryService;
  /** L2 knowledge graph store — backs the read-only graph viewer. */
  graphStore: L2Provider;
  /** Assemble the read-only mem0 explorer view (entries + cluster projection + status). */
  getMem0Data: () => Promise<GetMem0DataResponse>;
  /** All L3 inferred laws across scopes (read-only Memory panel). */
  getLaws: () => Promise<GetLawsResponse>;
  /** Persist + hot-apply the active memory backend (config write). */
  memorySetBackend: (backend: MemoryBackendId) => Promise<void>;
  /** Persist + hot-apply mem0's model selection (chosen from Monad's model registry). */
  memorySetMem0Models: (sel: SetMem0ModelsRequest) => Promise<void>;
  /** Persist + hot-apply the L2 knowledge-graph consolidation settings. */
  memorySetGraph: (sel: SetMemoryGraphRequest) => Promise<void>;
  kv?: KvService;
  mockMode?: boolean;
  /** Human-in-the-loop approval gate for high-risk tool calls. */
  oversight: OversightService;
  /** Agent → human free-text question channel (the `clarify_ask` tool). */
  clarify: ClarifyService;
  /** External IM channel gateway (Telegram, …) — for settings CRUD + live status. */
  channelService: ChannelService;
  /** Locale gateway — backs /v1/settings/locale + the web catalog endpoint. */
  localeService: I18nService;
  configBus?: ConfigBus;
  connectObscura?: (config: ObscuraConfig, command: string) => Promise<{ connected: boolean; tools: string[] }>;
  disconnectObscura?: () => Promise<void>;
  getObscuraStatus?: () => { connected: boolean; tools: string[] };
  /** Live MCP connection health (config + presets + file/pack + obscura) for the status endpoint. */
  getMcpStatus?: () => Promise<McpServerStatus[]>;
  /** Run the interactive OAuth flow for a config http oauth server, then reconnect it. */
  mcpAuthorize?: (name: string) => Promise<void>;
  /** Manually (re)connect a single config MCP server (retry a boot-time failure). */
  mcpReconnect?: (name: string) => Promise<void>;
  /** Re-discover atom packs after install/remove (refresh the channel registry without a restart). */
  rediscoverAtomPacks?: () => Promise<void>;
  /** Bare-name collisions surfaced from the last load sweep (for the conflict UI). */
  getAtomConflicts?: () => AtomConflict[];
  /** Per-pack individual atoms (by pack folder name) from the last load sweep, for the detail view. */
  getAtomDetails?: (packName: string) => import('@monad/protocol').AtomDescriptor[] | undefined;
  /** Workspace experiences registered by atom packs during the last load sweep. */
  getWorkspaceExperiences?: () => import('@monad/protocol').WorkspaceExperienceDefinition[];
  /** Boot/rediscovery-built public workspace experience snapshot. */
  getWorkspaceExperienceSnapshot?: () => import('@monad/protocol').WorkspaceExperienceDefinition[] | undefined;
  /** Workspace experience API routes registered by atom packs during the last load sweep. */
  getWorkspaceExperienceApiHandler?: (
    experienceId: string,
    method: string,
    path: string
  ) => WorkspaceExperienceApiHandler | undefined;
  /** Clear all stored embeddings and kick the indexer to rebuild — invoked when the user switches
   *  the embedding model and opts to re-index from scratch. */
  reindexEmbeddings?: () => void;
  /** Live indexer state (pending count + running flag). Optional so mock/test setups can omit it. */
  indexerStatus?: () => IndexerStatus;
  skills: SkillListItem[];
  skillInstances?: SkillListInstance[];
  /** Daemon-level warnings surfaced through /health (e.g. TLS unavailable). */
  daemonWarnings?: string[];
  /** SHA-256 fingerprint of the active TLS cert, surfaced through /health for TOFU verification. */
  certFingerprint?: string;
  /** ISO-8601 expiry of the active TLS cert, surfaced through /health so clients can warn before it expires. */
  certExpiry?: string;
  /** Test/runtime override for browser-attached native CLI auth connect heartbeat pruning. */
  nativeCliAuthHeartbeatTimeoutMs?: number;
  /** Loopback URL that managed native CLI runtimes use to call the daemon. */
  nativeCliServerUrl?: string;
  /** Getter for background upgrade check result — populated asynchronously after startup. */
  getUpgradeInfo?: () => { latestVersion: string; latestVersionCheckedAt: string } | null;
  log: Logger;
}
