import type { ChannelInstanceConfig } from '@monad/environment';
import type { StrictTranslateForNamespace } from '@monad/i18n';
import type { AgentId, ChannelType, SessionId, SessionOrigin, SessionTransport } from '@monad/protocol';
import type { ChannelAdapter, ChannelAdapterFactory } from '@monad/sdk-atom';
import type { CommandBundle } from '#/handlers/commands/index.ts';
import type { EventBus, EventSink } from '#/services/event-bus.ts';
import type { Store } from '#/store/db/index.ts';

export interface SessionGateway {
  create(args: { title: string; agentId?: AgentId; origin?: SessionOrigin }): Promise<{
    sessionId: SessionId;
  }>;
  sendInline(
    args: { sessionId: SessionId; text: string },
    sink: EventSink,
    runOpts?: { transport?: SessionTransport }
  ): Promise<void>;
  /** Clear a session's history (for /reset over a channel). Optional: tests omit the command path. */
  reset?(args: { id: SessionId }): Promise<{ clearedCount: number }>;
  /** Archive a session (for /archive over a channel). Optional: tests omit the command path. */
  update?(args: { id: SessionId; archived?: boolean }): Promise<unknown>;
  /** Set the session's shared working folder (for /workdir over a channel). Optional: tests omit it. */
  setWorkspace?(args: { id: SessionId; cwd: string }): Promise<{ cwd?: string }>;
}

export interface ChannelLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type ChannelTranslate = StrictTranslateForNamespace<'channel'>;

export interface ChannelServiceDeps {
  session: SessionGateway;
  store: Store;
  registry: Map<ChannelType, ChannelAdapterFactory>;
  log: ChannelLogger;
  /** Event bus — command turns publish a directive here so other clients (e.g. web viewing the same
   *  session) render the command + reply live, matching every other transport. Also used to subscribe
   *  to sessions for outbound mirroring (adapter.capabilities.outboundMirror). */
  bus: EventBus;
  /** Active-locale translator (hot-reloaded). Localizes channel renderer notices + the rate-limit
   *  reply. A stable function — capture once; it always resolves against the current locale. */
  t: ChannelTranslate;
  /** Unified slash-command backend. When present, ALL in-band commands (/new, /reset, /model, /help,
   *  atom pack commands…) are dispatched through the shared registry. */
  commands?: CommandBundle;
}

export interface Instance {
  config: ChannelInstanceConfig;
  adapter?: ChannelAdapter;
  abort: AbortController;
  connected: boolean;
  lastError?: string;
  /** native-message dedupe (long-poll can redeliver). */
  seen: Set<string>;
  /** per-conversation serialization — one run at a time per chat. */
  locks: Map<string, Promise<void>>;
  /** per-user token buckets for rate limiting. */
  buckets: Map<string, { tokens: number; last: number }>;
}

export type ChannelRoute =
  | { kind: 'default'; agentId?: undefined }
  | { kind: 'agent_direct'; agentId: string; agentName: string };
