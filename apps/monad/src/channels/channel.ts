// ChannelService owns the conversation→session mapping (adapters never see a sessionId)
// and drives the inbound → agent → outbound loop. It CALLS handlers.session but is not
// wired as part of createDaemonHandlers.

import type { ChannelInstanceConfig, MonadAuth, MonadConfig } from '@monad/home';
import type {
  AgentId,
  AgentMessagePayload,
  ChannelId,
  ChannelInbound,
  ChannelPairingRequest,
  ChannelStatus,
  ChannelType,
  SessionId
} from '@monad/protocol';
import type { ChannelAdapter, ChannelAdapterFactory, ChannelLog } from '@monad/sdk-atom';
import type { ChannelRoute, ChannelServiceDeps, ChannelTranslate, Instance } from '#/channels/types.ts';

import { channelDisplayText, parseEventPayload } from '@monad/protocol';

import { type CommandHost, runCommand } from '#/channels/command-dispatch.ts';
import { rateOk, serialize } from '#/channels/flow-control.ts';
import { errMsg, redact, rememberSeen, resolveExtra } from '#/channels/helpers.ts';
import { type MirrorContext, subscribeMirror } from '#/channels/mirror.ts';
import { ChannelPairings } from '#/channels/pairing.ts';
import { createRenderer } from '#/channels/render.ts';
import {
  accessDecision,
  channelOriginExt,
  deriveKey,
  needsReset,
  principalFor,
  routeInbound
} from '#/channels/routing.ts';
import { resolveChannelSecretRef } from '#/config/secrets.ts';
import { buildSessionOrigin } from '#/handlers/session/origin.ts';
import { daemonChildProcesses, killDaemonProcessTree } from '#/infra/daemon-child-processes.ts';

export type { ChannelLogger, ChannelRoute, ChannelServiceDeps, Instance, SessionGateway } from '#/channels/types.ts';

export class ChannelService {
  private readonly instances = new Map<ChannelId, Instance>();
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
        const mirror = this.sessionMirrors.get(event.sessionId);
        if (mirror) {
          mirror.unsubscribe();
          this.sessionMirrors.delete(event.sessionId);
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
      trackProcess: (proc, label) => {
        const trackedLabel = label ?? `channel:${c.type}`;
        daemonChildProcesses.track(proc.pid, trackedLabel, () => {
          if (proc.pid) killDaemonProcessTree(proc.pid);
          else proc.kill?.('SIGTERM');
        });
        if (proc.exited) void proc.exited.then(() => daemonChildProcesses.untrack(proc.pid));
      },
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
        .filter((s) => s.type === 'action' && s.source === 'builtin' && s.enabled && /^[a-z0-9_]+$/.test(s.id))
        .map((s) => ({ command: s.id, description: s.description }));
      void adapter
        .setCommands(cmds)
        .catch((err) => this.deps.log.warn(`channel "${c.id}": setCommands failed: ${errMsg(err)}`));
    }

    // Pre-register outbound mirrors for all known sessions so web-UI messages are mirrored
    // to Telegram even after a daemon restart.
    for (const conv of this.deps.store.listActiveConversations(c.id)) {
      this.registerMirror(c.id, conv.conversationKey, conv.activeSessionId as SessionId, adapter);
    }
  }

  private mirrorContext(): MirrorContext {
    return {
      sessionMirrors: this.sessionMirrors,
      activeDispatches: this.activeDispatches,
      bus: this.deps.bus,
      log: this.deps.log,
      t: this.channelT
    };
  }

  private registerMirror(
    channelId: string,
    conversationKey: string,
    sessionId: SessionId,
    adapter: ChannelAdapter
  ): void {
    subscribeMirror(this.mirrorContext(), channelId, conversationKey, sessionId, adapter);
  }

  private async disconnectOne(id: ChannelId): Promise<void> {
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

    const decision = accessDecision(c, m);
    if (decision === 'deny') {
      this.deps.log.warn(`channel "${c.id}": dropped message from unauthorized user`);
      return;
    }
    if (decision === 'pair') {
      await this.pairings.issue(inst, m);
      return;
    }

    const route = routeInbound(this.cfg, c, m);
    if (!route) return;

    if (!rateOk(inst, m.userId)) {
      await inst.adapter?.send(m.chatId, this.channelT('channel.rateLimited')).catch(() => {});
      return;
    }

    const key = deriveKey(c, m, route.agentId);
    // Serialize per conversation: beginRun overwrites a per-session single-slot AbortController,
    // so two concurrent runs on one chat would cross-wire streaming edits.
    await serialize(inst, key, async () => {
      await this.dispatch(inst, m, key, route);
    });
  }

  private async dispatch(
    inst: Instance,
    m: ChannelInbound,
    key: string,
    route: ChannelRoute = { kind: 'default' }
  ): Promise<string | undefined> {
    const c = inst.config;
    if (!inst.adapter) return;

    // In-band slash commands run through the SAME unified registry as every other transport: the
    // command turn is persisted as a directive + published to the bus (so a web client on the same
    // session sees it), rendered back to IM, and the command message gets a ✅ receipt. Unknown
    // commands fall through to the agent as plain text.
    if (
      m.kind === 'command' &&
      m.command &&
      this.deps.commands &&
      (await runCommand(this.commandHost(), inst, c, key, m))
    )
      return;

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
    return displayText;
  }

  private commandHost(): CommandHost {
    return {
      deps: this.deps,
      channelT: this.channelT,
      instances: this.instances,
      resolveSession: (c, key, label, agentId, role) => this.resolveSession(c, key, label, agentId, role),
      startNewSession: (c, key, label, agentId, role) => this.startNewSession(c, key, label, agentId, role),
      registerMirror: (channelId, conversationKey, sessionId, adapter) =>
        this.registerMirror(channelId, conversationKey, sessionId, adapter)
    };
  }

  private async resolveSession(
    c: ChannelInstanceConfig,
    key: string,
    label?: string,
    agentId?: string,
    role?: ChannelRoute['kind']
  ): Promise<SessionId> {
    const existing = this.deps.store.getActiveConversation(c.id, key);
    if (existing && !needsReset(c, existing)) {
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
    _role?: ChannelRoute['kind']
  ): Promise<SessionId> {
    const principalId = principalFor(c.id);
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
        ext: channelOriginExt(c)
      })
    });
    this.deps.store.setActiveSession({ channelId: c.id, conversationKey: key, sessionId, principalId, label: title });
    return sessionId;
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
}

export { sweepIdleBuckets } from '#/channels/helpers.ts';
