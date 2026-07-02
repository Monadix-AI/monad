// ChannelService owns the conversation→session mapping (adapters never see a sessionId)
// and drives the inbound → agent → outbound loop. It CALLS handlers.session but is not
// wired as part of createDaemonHandlers.

import type { ChannelInstanceConfig, MonadAuth, MonadConfig } from '@monad/home';
import type { StrictTranslateForNamespace } from '@monad/i18n';
import type {
  AgentId,
  AgentMessagePayload,
  ChannelInbound,
  ChannelPairingRequest,
  ChannelStatus,
  ChannelType,
  PrincipalId,
  SessionId,
  SessionOrigin,
  SessionTransport,
  TranscriptTargetId
} from '@monad/protocol';
import type { ChannelAdapter, ChannelAdapterFactory, ChannelLog } from '@monad/sdk-atom';
import type { EventBus, EventSink } from '@/services/event-bus.ts';
import type { Store } from '@/store/db/index.ts';

import { channelDisplayText, parseEventPayload } from '@monad/protocol';

import {
  addressedToBot,
  channelStructuredResponseHint,
  errMsg,
  mentionedAgents,
  moderatorAgentHint,
  redact,
  rememberSeen,
  resolveExtra,
  sweepIdleBuckets
} from '@/channels/helpers.ts';
import {
  dispatchAgentResultToModerator,
  dispatchModeratorNextTargets,
  type ModeratorRuntime,
  recoverOpenModeratorRounds
} from '@/channels/moderator.ts';
import { ChannelPairings } from '@/channels/pairing.ts';
import { createRenderer } from '@/channels/render.ts';
import { resolveChannelSecretRef } from '@/config/secrets.ts';
import {
  type CommandBundle,
  type CommandExecution,
  type CommandServices,
  emitCommandTurn,
  executeCommand,
  type SessionNavigator
} from '@/handlers/commands/index.ts';
import { buildSessionOrigin } from '@/handlers/session/origin.ts';

export interface SessionGateway {
  createForPrincipal(args: {
    title: string;
    agentId?: AgentId;
    principalId: PrincipalId;
    origin?: SessionOrigin;
  }): Promise<{
    sessionId: SessionId;
  }>;
  sendInline(
    args: { sessionId: SessionId; text: string },
    sink: EventSink,
    runOpts?: { transport?: SessionTransport }
  ): Promise<void>;
  /** Clear a session's history (for /reset over a channel). Optional: tests omit the command path. */
  reset?(args: { id: TranscriptTargetId }): Promise<{ clearedCount: number }>;
  /** Set the session's shared working folder (for /workdir over a channel). Optional: tests omit it. */
  setWorkspace?(args: { id: TranscriptTargetId; cwd: string }): Promise<{ cwd?: string }>;
}

export interface ChannelLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function sessionOnlyId(sessionId: TranscriptTargetId, command: string): SessionId {
  if (sessionId.startsWith('ses_')) return sessionId as SessionId;
  throw new Error(`${command} is only available in Monad agent sessions`);
}

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
  /** Moderator fanout waits for all assigned agents, then times out to avoid wedging the channel. */
  moderatorTaskTimeoutMs?: number;
}

type ChannelTranslate = StrictTranslateForNamespace<'channel'>;

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

/** Soft cap on per-user rate-limit buckets before an idle-bucket sweep runs. */
const BUCKET_CAP = 1000;

export type ChannelRoute =
  | { kind: 'default'; agentId?: undefined }
  | { kind: 'moderator'; agentId: string }
  | { kind: 'agent_direct'; agentId: string; agentName: string }
  | { kind: 'agent'; agentId: string; agentName: string; moderatorAgentId: string };

export class ChannelService {
  private readonly instances = new Map<string, Instance>();
  private cfg: MonadConfig;
  private auth: MonadAuth;
  /** Live type→factory map. Swappable so a freshly-installed atom pack's type is usable without a
   *  daemon restart (the settings reload that adds the channel config then finds the new type). */
  private registry: Map<ChannelType, ChannelAdapterFactory>;
  /** Per-session outbound mirror state. Populated at dispatch() time + on startup from store. */
  private readonly sessionMirrors = new Map<string, { channelId: string; unsubscribe: () => void }>();
  /** Sessions currently running a Telegram-inbound dispatch — the EventBus mirror skips these
   *  to prevent double-sending (sendInline already routes events via a direct renderer sink). */
  private readonly activeDispatches = new Set<string>();
  /** Unsubscribe function for the control-bus subscription that cleans up mirrors on session deletion. */
  private controlUnsubscribe: (() => void) | undefined;
  private readonly pairings: ChannelPairings;
  private readonly channelT: ChannelTranslate;
  private readonly moderatorRounds: ModeratorRuntime['rounds'] = new Map();

  constructor(
    private readonly deps: ChannelServiceDeps,
    cfg: MonadConfig,
    auth: MonadAuth
  ) {
    this.cfg = cfg;
    this.auth = auth;
    this.registry = deps.registry;
    this.channelT = deps.t;
    this.pairings = new ChannelPairings(deps.log, this.channelT);
  }

  /** Swap the live type→factory map (e.g. after an atom pack install/remove re-discovers). New types
   *  become connectable on the next reload; any running channel whose adapter type vanished
   *  (its atom pack was removed/disabled) is disconnected so a later reload can't crash on it. */
  async setRegistry(registry: Map<ChannelType, ChannelAdapterFactory>): Promise<void> {
    this.registry = registry;
    for (const [id, inst] of [...this.instances]) {
      if (!registry.has(inst.config.type)) {
        this.deps.log.warn(`channel "${id}": adapter type "${inst.config.type}" no longer available — disconnecting`);
        await this.disconnectOne(id);
      }
    }
  }

  /** Connect every enabled channel. Non-fatal per channel (mirrors the MCP-connect loop). */
  async start(): Promise<void> {
    // Clean up outbound mirrors when sessions are deleted from any client.
    this.controlUnsubscribe = this.deps.bus.subscribeControl((event) => {
      if (event.type === 'session.deleted') {
        const mirror = this.sessionMirrors.get(event.transcriptTargetId);
        if (mirror) {
          mirror.unsubscribe();
          this.sessionMirrors.delete(event.transcriptTargetId);
        }
      }
    });
    for (const c of this.cfg.channels) {
      if (!c.enabled) continue;
      await this.connectOne(c).catch((err) => {
        this.deps.log.warn(`channel "${c.id}" failed to connect: ${errMsg(err)}`);
      });
    }
  }

  /** Diff desired vs running: connect added, disconnect removed, reconnect changed. */
  async reload(cfg: MonadConfig, auth: MonadAuth): Promise<void> {
    this.cfg = cfg;
    this.auth = auth;
    const desired = new Map(cfg.channels.filter((c) => c.enabled).map((c) => [c.id, c] as const));

    for (const [id, inst] of this.instances) {
      const next = desired.get(id);
      if (!next || JSON.stringify(next) !== JSON.stringify(inst.config)) {
        await this.disconnectOne(id);
      }
    }
    for (const [id, c] of desired) {
      if (!this.instances.has(id)) {
        await this.connectOne(c).catch((err) =>
          this.deps.log.warn(`channel "${id}" failed to (re)connect: ${errMsg(err)}`)
        );
      }
    }
  }

  async stop(): Promise<void> {
    this.controlUnsubscribe?.();
    this.controlUnsubscribe = undefined;
    for (const id of [...this.instances.keys()]) await this.disconnectOne(id);
  }

  statusSnapshot(): ChannelStatus[] {
    return this.cfg.channels.map((c) => {
      const inst = this.instances.get(c.id);
      return {
        id: c.id as ChannelStatus['id'],
        type: c.type,
        enabled: c.enabled,
        connected: inst?.connected ?? false,
        hasToken: this.hasToken(c),
        activeConversations: this.deps.store.countActiveConversations(c.id),
        ...(inst?.lastError ? { lastError: inst.lastError } : {})
      };
    });
  }

  private hasToken(c: ChannelInstanceConfig): boolean {
    try {
      return Boolean(resolveChannelSecretRef(c.tokenRef, this.auth));
    } catch {
      return false;
    }
  }

  private async connectOne(c: ChannelInstanceConfig): Promise<void> {
    const factory = this.registry.get(c.type);
    if (!factory) throw new Error(`unknown channel type: ${c.type}`);

    const token = resolveChannelSecretRef(c.tokenRef, this.auth);
    const secrets: Record<string, string> = { token, ...resolveExtra(c.id, this.auth) };
    const abort = new AbortController();

    const inst: Instance = {
      config: c,
      adapter: undefined,
      abort,
      connected: false,
      seen: new Set(),
      locks: new Map(),
      buckets: new Map()
    };
    this.instances.set(c.id, inst);

    const log: ChannelLog = (level, msg, fields) => {
      const redacted = redact(`[${c.id}] ${msg}${fields ? ` ${JSON.stringify(fields)}` : ''}`, secrets);
      this.deps.log[level](redacted);
    };

    const adapter = factory({
      // Narrow atom-pack-visible config — host concerns (allowlist/mapping/tokenRef) are withheld.
      config: { id: c.id, type: c.type, label: c.label, options: c.options },
      secrets,
      signal: abort.signal,
      log,
      onMessage: (m) => void this.onInbound(inst, m).catch((e) => log('error', errMsg(e)))
    });
    inst.adapter = adapter;

    try {
      await adapter.connect();
      inst.connected = true;
      inst.lastError = undefined;
      this.deps.log.info(`channel "${c.id}" (${c.type}) connected`);
    } catch (err) {
      inst.connected = false;
      inst.lastError = errMsg(err);
      throw err;
    }

    if (adapter.capabilities.nativeCommands && adapter.setCommands && this.deps.commands) {
      const bundle = this.deps.commands;
      const cmds = bundle.registry
        .list(bundle.skills(), this.deps.t)
        .filter((s) => s.kind === 'builtin' && s.available && /^[a-z0-9_]+$/.test(s.name))
        .map((s) => ({ command: s.name, description: s.description }));
      void adapter
        .setCommands(cmds)
        .catch((err) => this.deps.log.warn(`channel "${c.id}": setCommands failed: ${errMsg(err)}`));
    }

    // Pre-register outbound mirrors for all known sessions so web-UI messages are mirrored
    // to Telegram even after a daemon restart.
    for (const conv of this.deps.store.listActiveConversations(c.id)) {
      this.registerMirror(c.id, conv.conversationKey, conv.activeSessionId as SessionId, adapter);
    }
    await recoverOpenModeratorRounds(this.moderatorRuntime(), inst);
  }

  /** Register an EventBus subscription that mirrors agent replies back to a channel chat.
   *  Only active when adapter.capabilities.outboundMirror is true. Idempotent. */
  private registerMirror(
    channelId: string,
    conversationKey: string,
    sessionId: SessionId,
    adapter: ChannelAdapter
  ): void {
    if (!adapter.capabilities.outboundMirror) return;
    if (this.sessionMirrors.has(sessionId)) return;

    const parts = conversationKey.split('|');
    const chatId = parts[1];
    if (!chatId) return;
    const threadId = parts[2]?.startsWith('t:') ? parts[2].slice(2) : undefined;

    const log: ChannelLog = (level, msg) => this.deps.log[level](`[${channelId}] mirror: ${msg}`);
    const t = this.channelT;
    let currentRenderer: ReturnType<typeof createRenderer> | undefined;

    const unsubscribe = this.deps.bus.subscribe(sessionId, (event) => {
      if (this.activeDispatches.has(sessionId)) return;
      switch (event.type) {
        case 'user.message':
          currentRenderer = undefined;
          break;
        case 'agent.token':
        case 'agent.message':
        case 'tool.approval_requested':
        case 'agent.error':
          if (!currentRenderer) currentRenderer = createRenderer({ adapter, chatId, threadId, log, t });
          currentRenderer.consume(event);
          if (
            event.type === 'agent.message' ||
            event.type === 'agent.error' ||
            event.type === 'tool.approval_requested'
          ) {
            const r = currentRenderer;
            currentRenderer = undefined;
            void r.finalize().catch((err: unknown) => log('warn', `finalize failed: ${errMsg(err)}`));
          }
          break;
        default:
          break;
      }
    });

    this.sessionMirrors.set(sessionId, { channelId, unsubscribe });
  }

  private async disconnectOne(id: string): Promise<void> {
    const inst = this.instances.get(id);
    if (!inst) return;
    inst.abort.abort();
    try {
      await inst.adapter?.disconnect();
    } catch {
      /* best effort */
    }
    this.instances.delete(id);

    // Unsubscribe all outbound mirrors belonging to this channel.
    for (const [sid, entry] of this.sessionMirrors) {
      if (entry.channelId === id) {
        entry.unsubscribe();
        this.sessionMirrors.delete(sid);
      }
    }
  }

  private async onInbound(inst: Instance, m: ChannelInbound): Promise<void> {
    const c = inst.config;
    if (m.isSelf) return; // echo guard
    if (inst.seen.has(m.nativeMessageId)) return; // long-poll redelivery
    rememberSeen(inst.seen, m.nativeMessageId);

    const decision = this.accessDecision(c, m);
    if (decision === 'deny') {
      this.deps.log.warn(`channel "${c.id}": dropped message from unauthorized user`);
      return;
    }
    if (decision === 'pair') {
      await this.pairings.issue(inst, m);
      return;
    }

    const route = this.routeInbound(c, m);
    if (!route) return;

    if (!this.rateOk(inst, m.userId)) {
      await inst.adapter?.send(m.chatId, this.channelT('channel.rateLimited')).catch(() => {});
      return;
    }

    const key = this.deriveKey(c, m, route.agentId);
    // Serialize per conversation: beginRun overwrites a per-session single-slot AbortController,
    // so two concurrent runs on one chat would cross-wire streaming edits.
    await this.serialize(inst, key, async () => {
      await this.dispatch(inst, m, key, route, 0);
    });
  }

  private async dispatch(
    inst: Instance,
    m: ChannelInbound,
    key: string,
    route: ChannelRoute = { kind: 'default' },
    moderatorDepth = 0
  ): Promise<string | undefined> {
    const c = inst.config;
    if (!inst.adapter) return;

    // In-band slash commands run through the SAME unified registry as every other transport: the
    // command turn is persisted as a directive + published to the bus (so a web client on the same
    // session sees it), rendered back to IM, and the command message gets a ✅ receipt. Unknown
    // commands fall through to the agent as plain text.
    if (m.kind === 'command' && m.command && this.deps.commands && (await this.runCommand(inst, c, key, m))) return;

    const sessionId = await this.resolveSession(c, key, m.senderDisplay, route.agentId, route.kind);
    // Ensure an outbound mirror subscription exists for this session (idempotent).
    this.registerMirror(c.id, key, sessionId, inst.adapter);
    // Mark as active so the EventBus mirror sink skips events during this direct dispatch —
    // sendInline already delivers them via renderer.consume and would double-send otherwise.
    this.activeDispatches.add(sessionId);
    const renderer = createRenderer({
      adapter: inst.adapter,
      chatId: m.chatId,
      threadId: m.threadId,
      log: (level, msg) => this.deps.log[level](`[${c.id}] ${msg}`),
      t: this.channelT
    });
    let finalMessage: AgentMessagePayload | undefined;
    try {
      await this.deps.session.sendInline(
        { sessionId, text: m.text },
        (event) => {
          renderer.consume(event);
          if (event.type === 'agent.message') {
            finalMessage = parseEventPayload('agent.message', event.payload);
          }
        },
        { transport: 'channel' }
      );
      await renderer.finalize();
    } finally {
      this.activeDispatches.delete(sessionId);
    }
    const displayText = finalMessage?.text ? channelDisplayText(finalMessage.text) : undefined;
    if (route.kind === 'agent' && route.moderatorAgentId && finalMessage?.text.trim()) {
      await dispatchAgentResultToModerator(this.moderatorRuntime(), inst, m, key, route, displayText ?? '');
    }
    if (route.kind === 'moderator' && finalMessage?.text.trim()) {
      await dispatchModeratorNextTargets(
        this.moderatorRuntime(),
        inst,
        m,
        key,
        route,
        finalMessage.text,
        moderatorDepth
      );
    }
    return displayText;
  }

  private moderatorRuntime(): ModeratorRuntime {
    return {
      cfg: () => this.cfg,
      store: this.deps.store,
      log: this.deps.log,
      moderatorTaskTimeoutMs: this.deps.moderatorTaskTimeoutMs,
      rounds: this.moderatorRounds,
      deriveKey: (c, m, agentId) => this.deriveKey(c, m, agentId),
      serialize: (inst, key, fn) => this.serialize(inst, key, fn),
      dispatch: (inst, m, key, route, depth) => this.dispatch(inst, m, key, route, depth)
    };
  }

  /** Dispatch one in-band command through the unified registry with a conversation-keyed navigator.
   *  Returns false when the text isn't a host command (→ caller routes it to the agent). */
  private async runCommand(inst: Instance, c: ChannelInstanceConfig, key: string, m: ChannelInbound): Promise<boolean> {
    if (!inst.adapter) return false;
    const bundle = this.deps.commands;
    if (!bundle) return false;
    const sessionId = await this.resolveSession(c, key, m.senderDisplay);
    const text = `/${m.command}${m.commandArgs.length ? ` ${m.commandArgs.join(' ')}` : ''}`;
    const approve = bundle.approveHighRisk;
    const exec: CommandExecution = {
      registry: bundle.registry,
      navigator: this.conversationNavigator(c, key, m.senderDisplay),
      principalId: this.principalFor(c.id),
      // A channel guest is the daemon owner only when its native user id is in this channel's
      // ownerUsers allowlist (gates owner-only commands like /workdir). The channel serializes per
      // conversation (one run at a time), so a command never races an in-flight turn → not busy.
      isOwner: c.ownerUsers.includes(m.userId),
      isBusy: false,
      gate: approve ? (def) => approve(sessionId, def) : undefined,
      services: this.channelServices(bundle)
    };
    const result = await executeCommand(exec, sessionId, text);
    if (result === null) return false;

    // Render the directive reply to IM (renderer turns the agent.message event into adapter.send),
    // and publish to the bus so cross-client viewers see the same turn.
    const renderer = createRenderer({
      adapter: inst.adapter,
      chatId: m.chatId,
      threadId: m.threadId,
      log: (level, msg) => this.deps.log[level](`[${c.id}] ${msg}`),
      t: this.channelT
    });
    emitCommandTurn(
      this.deps.store,
      (e) => {
        this.deps.bus.publish(e);
        renderer.consume(e);
      },
      sessionId,
      text,
      result
    );
    await renderer.finalize();

    // IM-native receipt: a ✅ on the command message — feedback even when the reply has no text
    // (e.g. /clear). Non-fatal: a platform that rejects the reaction just doesn't show one.
    if (inst.adapter?.react && inst.adapter?.capabilities.reactions) {
      await inst.adapter
        ?.react({ chatId: m.chatId, messageId: m.nativeMessageId }, '✅')
        .catch((err) => this.deps.log.warn(`channel "${c.id}": react failed: ${errMsg(err)}`));
    }
    return true;
  }

  private channelServices(bundle: CommandBundle): CommandServices {
    return {
      resetHistory: (sid) =>
        this.deps.session.reset
          ? this.deps.session.reset({ id: sid })
          : Promise.reject(new Error('reset is unavailable')),
      compact: (sid) => bundle.compact(sessionOnlyId(sid, 'compact')),
      consolidate: (level?: number) => bundle.consolidate(level),
      explainBelief: (sid, query) => bundle.explainBelief(sessionOnlyId(sid, 'belief'), query),
      checkMemory: () => bundle.checkMemory(),
      listModels: (sid) => bundle.listModels(sessionOnlyId(sid, 'model')),
      setModel: (sid, alias) => bundle.setModel(sessionOnlyId(sid, 'model'), alias),
      getWorkdir: async (sid) => ({
        path: (this.deps.store.getSession(sid) ?? this.deps.store.getWorkplaceProject(sid))?.cwd
      }),
      setWorkdir: (sid, path) =>
        this.deps.session.setWorkspace
          ? this.deps.session.setWorkspace({ id: sid, cwd: path }).then((r) => ({ path: r.cwd }))
          : Promise.reject(new Error('setWorkspace is unavailable')),
      handoff: (sid, initialTask) => bundle.handoff(sessionOnlyId(sid, 'handoff'), initialTask),
      listCommands: async () => bundle.registry.list(bundle.skills(), this.deps.t),
      t: this.deps.t,
      log: bundle.log
    };
  }

  /** Conversation-keyed navigator: a single chat multiplexes many sessions via the store's
   *  conversation mapping (the channel's session model, distinct from generic transports). */
  private conversationNavigator(c: ChannelInstanceConfig, key: string, label?: string): SessionNavigator {
    const { store } = this.deps;
    const channelId = c.id;
    return {
      newSession: async (l) => ({ sessionId: await this.startNewSession(c, key, l ?? label) }),
      listSessions: async () => {
        const list = store.listConversationSessions(channelId, key);
        const active = store.getActiveConversation(channelId, key)?.activeSessionId;
        return list.map((s) => ({
          sessionId: s.sessionId,
          label: s.label ?? undefined,
          active: s.sessionId === active
        }));
      },
      switchSession: async (target) => {
        const list = store.listConversationSessions(channelId, key);
        const byIndex = /^\d+$/.test(target) ? list[Number(target) - 1] : undefined;
        const found = byIndex ?? list.find((s) => s.sessionId === target);
        if (!found) return null;
        store.setActiveSession({
          channelId,
          conversationKey: key,
          sessionId: found.sessionId,
          principalId: this.principalFor(channelId)
        });
        // Register a mirror for the switched-to session so web-UI messages are immediately mirrored.
        const adapter = this.instances.get(channelId)?.adapter;
        if (adapter) this.registerMirror(channelId, key, found.sessionId as SessionId, adapter);
        return { sessionId: found.sessionId, label: found.label ?? undefined, active: true };
      }
    };
  }

  private deriveKey(c: ChannelInstanceConfig, m: ChannelInbound, agentId?: string): string {
    const parts = [c.id, m.chatId];
    if (c.mapping.granularity === 'per-thread' && m.threadId) parts.push(`t:${m.threadId}`);
    else if (c.mapping.granularity === 'per-user') parts.push(`u:${m.userId}`);
    if (agentId) parts.push(`a:${agentId}`);
    return parts.join('|');
  }

  private principalFor(channelId: string): PrincipalId {
    // Stable, low-privilege synthetic principal — derived from the channel's id suffix so it never
    // collides with the daemon owner. verification stays implicitly unverified. The config schema
    // permits any `chn_*` id, but PrincipalId must match `prn_[A-Z0-9]+` or session-list responses
    // fail validation — so uppercase the suffix and strip non-alphanumerics (a no-op for ULID ids).
    const suffix = channelId
      .slice(4)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    return `prn_${suffix}` as PrincipalId;
  }

  private async resolveSession(
    c: ChannelInstanceConfig,
    key: string,
    label?: string,
    agentId?: string,
    role?: ChannelRoute['kind']
  ): Promise<SessionId> {
    const existing = this.deps.store.getActiveConversation(c.id, key);
    if (existing && !this.needsReset(c, existing)) {
      this.deps.store.touchConversation(c.id, key);
      return existing.activeSessionId as SessionId;
    }
    return this.startNewSession(c, key, label, agentId, role);
  }

  private async startNewSession(
    c: ChannelInstanceConfig,
    key: string,
    label?: string,
    agentId?: string,
    role?: ChannelRoute['kind']
  ): Promise<SessionId> {
    const principalId = this.principalFor(c.id);
    const agent = agentId ? this.cfg.agent.agents.find((a) => a.id === agentId) : undefined;
    const titleParts = [c.label, label, agent?.name].filter(Boolean);
    const title = titleParts.join(': ');
    const { sessionId } = await this.deps.session.createForPrincipal({
      title,
      agentId: (agentId ?? c.agentId) as AgentId | undefined,
      principalId,
      origin: buildSessionOrigin({
        transport: 'channel',
        surface: 'im',
        client: c.type, // 'telegram' | 'slack' | … — the concrete chat tool
        instanceId: c.id, // which configured channel instance
        // Per-channel system-prompt hint travels on the origin; sendInline reads it back as
        // ambientContext so it reaches the model on every turn (Hermes platform_hint).
        ext: this.channelOriginExt(c, role)
      })
    });
    this.deps.store.setActiveSession({ channelId: c.id, conversationKey: key, sessionId, principalId, label: title });
    return sessionId;
  }

  private channelOriginExt(c: ChannelInstanceConfig, role?: ChannelRoute['kind']): { agentHint?: string } | undefined {
    const hints = [c.agentHint?.trim(), channelStructuredResponseHint()].filter((s): s is string => Boolean(s));
    if (role === 'moderator') hints.push(moderatorAgentHint(this.cfg));
    if (!hints.length) return undefined;
    return { agentHint: hints.join('\n\n') };
  }

  private routeInbound(c: ChannelInstanceConfig, m: ChannelInbound): ChannelRoute | null {
    if (m.kind === 'command') return { kind: 'default' };
    const chatType = m.chatType ?? 'dm';
    const moderatorAgentId = c.groupPolicy?.moderatorAgentId;
    if (!moderatorAgentId) {
      const mentions = mentionedAgents(m.text, this.cfg.agent.agents);
      if ((chatType === 'group' || chatType === 'channel') && this.cfg.agent.agents.length > 0) {
        if (mentions.length === 0) return null;
        const [agent] = mentions;
        return agent ? { kind: 'agent_direct', agentId: agent.id, agentName: agent.name } : null;
      }
      if ((c.groupPolicy?.requireMention ?? true) && !addressedToBot(m)) return null;
      return { kind: 'default' };
    }

    const mentions = mentionedAgents(m.text, this.cfg.agent.agents);
    if (mentions.length === 1) {
      const [agent] = mentions;
      if (!agent) return null;
      return agent.id === moderatorAgentId
        ? { kind: 'moderator', agentId: moderatorAgentId }
        : { kind: 'agent', agentId: agent.id, agentName: agent.name, moderatorAgentId };
    }
    if (chatType === 'group' || chatType === 'channel' || chatType === 'dm') {
      return { kind: 'moderator', agentId: moderatorAgentId };
    }
    return null;
  }

  private needsReset(c: ChannelInstanceConfig, conv: { lastSeenAt: string; createdAt: string }): boolean {
    const reset = c.mapping.reset;
    if (!reset) return false;
    if (reset.idleMinutes && Date.now() - Date.parse(conv.lastSeenAt) > reset.idleMinutes * 60_000) return true;
    if (reset.daily && new Date(conv.createdAt).toDateString() !== new Date().toDateString()) return true;
    return false;
  }

  /** Decide what to do with an inbound from `userId`:
   *  - 'allow': dispatch to the agent.
   *  - 'deny':  drop silently (warned by caller).
   *  - 'pair':  unknown sender on a pairing-mode DM → issue/refresh a one-time code. */
  private accessDecision(c: ChannelInstanceConfig, m: ChannelInbound): 'allow' | 'deny' | 'pair' {
    const a = c.allowlist;
    // allowAllUsers is the pre-policy escape hatch; honour it as 'open' for back-compat. An absent
    // policy defaults to 'allowlist' (default-deny).
    const policy = a.allowAllUsers ? 'open' : (a.policy ?? 'allowlist');
    if (policy === 'disabled') return 'deny';
    if (policy === 'open') return 'allow';
    if (a.allowedUsers.includes(m.userId)) return 'allow';
    // Only ever issue pairing codes in 1:1 chats — never into a group.
    if (policy === 'pairing' && (m.chatType ?? 'dm') === 'dm') return 'pair';
    return 'deny';
  }

  /** Operator-facing: the live pairing requests awaiting approval for a channel. */
  listPendingPairings(channelId: string): ChannelPairingRequest[] {
    return this.pairings.list(channelId);
  }

  /** Validate + consume a pairing code. Returns the platform userId to allowlist, or null if the code
   *  is unknown/expired. The caller persists the userId to the channel config (which then reloads). */
  consumePairing(channelId: string, code: string): string | null {
    return this.pairings.consume(channelId, code);
  }

  private rateOk(inst: Instance, userId: string): boolean {
    const limit = inst.config.rateLimitPerMin;
    const now = Date.now();
    // `buckets` keeps one entry per user and is driven by external (channel-user) ids, so on an
    // allow-all channel it would grow without bound. Amortized sweep: when it gets large, drop
    // every bucket that has fully refilled — those are indistinguishable from a fresh default,
    // so dropping them is lossless and bounds the map to users currently being throttled.
    if (inst.buckets.size > BUCKET_CAP) sweepIdleBuckets(inst.buckets, now, limit);
    const b = inst.buckets.get(userId) ?? { tokens: limit, last: now };
    b.tokens = Math.min(limit, b.tokens + ((now - b.last) / 60_000) * limit);
    b.last = now;
    inst.buckets.set(userId, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private async serialize<T>(inst: Instance, key: string, fn: () => Promise<T>): Promise<T> {
    const prev = inst.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const guarded = run.then(
      () => {},
      () => {}
    );
    inst.locks.set(key, guarded);
    try {
      return await run;
    } finally {
      if (inst.locks.get(key) === guarded) inst.locks.delete(key);
    }
  }
}

export { sweepIdleBuckets } from '@/channels/helpers.ts';
