// ChannelService owns the conversation→session mapping (adapters never see a sessionId)
// and drives the inbound → agent → outbound loop. It CALLS handlers.session but is not
// wired as part of createDaemonHandlers.

import type { ChannelInstanceConfig, MonadAuth, MonadConfig } from '@monad/environment';
import type {
  AgentId,
  ChannelId,
  ChannelInbound,
  ChannelStatus,
  ChannelType,
  MessageOrigin,
  ProjectId,
  SessionId
} from '@monad/protocol';
import type {
  ChannelAdapter,
  ChannelAdapterFactory,
  ChannelLog,
  CommandProjectInfo,
  CommandProjectSelection
} from '@monad/sdk-atom';
import type { ChannelRoute, ChannelServiceDeps, ChannelTranslate, Instance } from '#/channels/types.ts';

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getPaths } from '@monad/environment';
import { channelDisplayText, parseEventPayload } from '@monad/protocol';

import { type CommandHost, runCommand } from '#/channels/command-dispatch.ts';
import { rateOk, serialize } from '#/channels/flow-control.ts';
import { errMsg, redact, rememberSeen, resolveExtra } from '#/channels/helpers.ts';
import { type MirrorContext, subscribeMirror } from '#/channels/mirror.ts';
import { type ChannelRenderMode, createRenderer } from '#/channels/render.ts';
import { channelOperatorContext, deriveKey, needsReset, routeInbound } from '#/channels/routing.ts';
import { buildOperationSource } from '#/handlers/session/origin.ts';
import { daemonChildProcesses, killDaemonProcessTree } from '#/infra/daemon-child-processes.ts';

export type { ChannelRoute, ChannelServiceDeps, Instance, SessionGateway } from '#/channels/types.ts';

export class ChannelService {
  private readonly instances = new Map<ChannelId, Instance>();
  private cfg: MonadConfig;
  /** Live type→factory map. Swappable so a freshly-installed atom pack's type is usable without a
   *  daemon restart (the settings reload that adds the channel config then finds the new type). */
  private registry: Map<ChannelType, ChannelAdapterFactory>;
  /** Per-session outbound mirror state. Populated at dispatch() time + on startup from store. */
  private readonly sessionMirrors = new Map<string, { channelId: string; unsubscribe: () => void }>();
  /** Sessions currently running a Telegram-inbound dispatch — the EventBus mirror skips these
   *  to prevent double-sending (sendInline already routes events via a direct renderer sink). */
  private readonly activeDispatches = new Set<string>();
  /** Per-channel-conversation presentation mode. Compact suppresses token previews on IM channels. */
  private readonly renderModes = new Map<string, ChannelRenderMode>();
  private readonly pendingProjects = new Map<string, { projectId: ProjectId; title: string }>();
  /** Unsubscribe function for the control-bus subscription that cleans up mirrors on session deletion. */
  private controlUnsubscribe: (() => void) | undefined;
  private readonly channelT: ChannelTranslate;

  constructor(
    private readonly deps: ChannelServiceDeps,
    cfg: MonadConfig,
    _auth: MonadAuth
  ) {
    this.cfg = cfg;
    this.registry = deps.registry;
    this.channelT = deps.t;
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
  async reload(cfg: MonadConfig, _auth: MonadAuth): Promise<void> {
    this.cfg = cfg;
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
        phase: c.enabled ? (inst?.phase ?? 'disconnected') : 'disabled',
        ...(inst?.pairingQr ? { pairingQr: inst.pairingQr } : {}),
        hasToken: this.hasToken(c),
        activeConversations: this.deps.store.countActiveConversations(c.id),
        ...(inst?.lastError ? { lastError: inst.lastError } : {})
      };
    });
  }

  private hasToken(c: ChannelInstanceConfig): boolean {
    try {
      return Boolean(c.credential?.token);
    } catch {
      return false;
    }
  }

  private async connectOne(c: ChannelInstanceConfig): Promise<void> {
    const factory = this.registry.get(c.type);
    if (!factory) throw new Error(`unknown channel type: ${c.type}`);

    const token = c.credential?.token;
    if (factory.connectionMode !== 'pairing' && !token) {
      throw new Error(`channel "${c.id}" credential is not configured`);
    }
    const secrets: Record<string, string> = { ...(token ? { token } : {}), ...resolveExtra(c) };
    const abort = new AbortController();

    const inst: Instance = {
      config: c,
      adapter: undefined,
      abort,
      connected: false,
      phase: 'connecting',
      seen: new Set(),
      locks: new Map(),
      buckets: new Map()
    };
    this.instances.set(c.id, inst);

    const log: ChannelLog = (level, msg, fields) => {
      const redacted = redact(`[${c.id}] ${msg}${fields ? ` ${JSON.stringify(fields)}` : ''}`, secrets);
      this.deps.log[level](redacted);
    };

    let statusPublished = false;
    const adapter = factory({
      // Narrow atom-pack-visible config — host concerns (mapping/credential) are withheld.
      config: {
        id: c.id,
        type: c.type,
        label: c.label,
        connectedWelcome: this.channelT('channel.connectedWelcome')
      },
      secrets,
      signal: abort.signal,
      stateDir: this.stateDir(c.id),
      onStatus: (status) => {
        statusPublished = true;
        inst.phase = status.phase;
        inst.connected = status.phase === 'connected';
        inst.pairingQr = status.pairingQr;
        if (status.error) inst.lastError = status.error;
        else if (status.phase !== 'error') inst.lastError = undefined;
      },
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
      if (!statusPublished && inst.phase === 'connecting' && factory.connectionMode !== 'pairing') {
        inst.connected = true;
        inst.phase = 'connected';
        inst.lastError = undefined;
      }
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
        .filter((s) => s.type === 'action' && s.source === 'builtin' && s.enabled)
        .map((s) => ({
          command: s.id,
          description: s.description,
          ...(s.args ? { args: s.args } : {}),
          ...(s.subcommands ? { subcommands: s.subcommands } : {})
        }));
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

  async beginPairing(id: ChannelId): Promise<void> {
    const config = this.cfg.channels.find((channel) => channel.id === id);
    if (!config) throw new Error(`channel not found: ${id}`);
    const factory = this.registry.get(config.type);
    if (factory?.connectionMode !== 'pairing') throw new Error(`channel "${id}" does not support pairing`);
    await this.logoutChannel(id);
    await this.disconnectOne(id);
    await rm(this.stateDir(id), { recursive: true, force: true });
    await this.connectOne({ ...config, enabled: true });
  }

  async logoutChannel(id: ChannelId): Promise<void> {
    await this.instances
      .get(id)
      ?.adapter?.logout?.()
      .catch(() => {});
  }

  async removeState(id: ChannelId): Promise<void> {
    await rm(this.stateDir(id), { recursive: true, force: true });
  }

  private stateDir(id: ChannelId): string {
    return join(getPaths().credentials, 'channels', id);
  }

  private mirrorContext(): MirrorContext {
    return {
      sessionMirrors: this.sessionMirrors,
      activeDispatches: this.activeDispatches,
      bus: this.deps.bus,
      log: this.deps.log,
      t: this.channelT,
      getRenderMode: (channelId, conversationKey) => this.getRenderMode(channelId, conversationKey),
      isActiveBinding: (channelId, conversationKey, sessionId) =>
        this.deps.store.getActiveConversation(channelId, conversationKey)?.activeSessionId === sessionId
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

  private renderModeKey(channelId: string, conversationKey: string): string {
    return `${channelId}\0${conversationKey}`;
  }

  private getRenderMode(channelId: string, conversationKey: string): ChannelRenderMode {
    return this.renderModes.get(this.renderModeKey(channelId, conversationKey)) ?? 'detail';
  }

  private setRenderMode(channelId: string, conversationKey: string, mode: ChannelRenderMode): void {
    this.renderModes.set(this.renderModeKey(channelId, conversationKey), mode);
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
    const pendingPrefix = `${id}\0`;
    for (const key of this.pendingProjects.keys()) {
      if (key.startsWith(pendingPrefix)) this.pendingProjects.delete(key);
    }
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

    const route = routeInbound(this.cfg, c, m, inst.adapter?.capabilities.groupMentionPolicy === true);
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

    const active = this.deps.store.getActiveConversation(c.id, key);
    const activeSession = active ? this.deps.store.getSession(active.activeSessionId) : undefined;
    const pendingProject = this.getPendingProject(c, key);
    const projectSessionRequired = !activeSession?.projectId && !pendingProject && !route.agentId && !c.agentId;

    // In-band slash commands run through the SAME unified registry as every other transport: the
    // command turn is persisted as a directive + published to the bus (so a web client on the same
    // session sees it), rendered back to IM, and the command message gets a ✅ receipt. Unknown
    // commands receive a context-specific unsupported reply; available Skill commands still fall through.
    if (m.kind === 'command' && m.command && this.deps.commands) {
      if (pendingProject && !['project', 'sessions', 'switch'].includes(m.command)) {
        await inst.adapter.send(m.chatId, this.channelT('channel.projectSessionPending'), { threadId: m.threadId });
        return;
      }
      if (projectSessionRequired && m.command !== 'project') {
        await inst.adapter.send(m.chatId, this.channelT('channel.projectSessionRequired'), { threadId: m.threadId });
        return;
      }
      if (
        await runCommand(this.commandHost(), inst, c, key, m, {
          sessionlessProject: projectSessionRequired || Boolean(pendingProject)
        })
      )
        return;
    }

    if (activeSession?.projectId) {
      const sessionId = activeSession.id as SessionId;
      this.deps.store.touchConversation(c.id, key);
      this.registerMirror(c.id, key, sessionId, inst.adapter);
      await this.sendProjectMessage(inst, m, sessionId);
      return;
    }
    if (pendingProject) {
      const sessionId = await this.startNewProjectSession(
        c,
        key,
        pendingProject.projectId,
        pendingProject.title,
        m.senderDisplay
      );
      this.clearPendingProject(c, key);
      this.registerMirror(c.id, key, sessionId, inst.adapter);
      await this.sendProjectMessage(inst, m, sessionId);
      return;
    }
    if (projectSessionRequired) {
      await inst.adapter.send(m.chatId, this.channelT('channel.projectSessionRequired'), { threadId: m.threadId });
      return;
    }

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
      t: this.channelT,
      renderMode: this.getRenderMode(c.id, key)
    });
    let finalMessageText: string | undefined;
    try {
      await this.deps.session.sendInline(
        { sessionId, text: m.text },
        (event) => {
          renderer.consume(event);
          if (event.type === 'session.message.completed') {
            const { message } = parseEventPayload('session.message.completed', event.payload);
            if (message.role === 'assistant') finalMessageText = message.text;
          }
        },
        {
          transport: 'channel',
          ambientContext: channelOperatorContext(c),
          origin: channelMessageOrigin(c, m)
        }
      );
      await renderer.finalize();
    } finally {
      this.activeDispatches.delete(sessionId);
    }
    const displayText = finalMessageText ? channelDisplayText(finalMessageText) : undefined;
    return displayText;
  }

  private async sendProjectMessage(inst: Instance, m: ChannelInbound, sessionId: SessionId): Promise<void> {
    if (!this.deps.session.sendProjectMessage) throw new Error('channel Project messaging is unavailable');
    await this.deps.session.sendProjectMessage({
      sessionId,
      text: m.text,
      origin: channelMessageOrigin(inst.config, m)
    });
    if (this.deps.store.listSessionMembers(sessionId).length === 0) {
      await inst.adapter?.send(m.chatId, this.channelT('channel.projectSessionNoMembers'), { threadId: m.threadId });
    }
  }

  private commandHost(): CommandHost {
    return {
      deps: this.deps,
      channelT: this.channelT,
      instances: this.instances,
      resolveSession: (c, key, label, agentId, role) => this.resolveSession(c, key, label, agentId, role),
      startNewSession: (c, key, label, agentId, role) => this.startNewSession(c, key, label, agentId, role),
      registerMirror: (channelId, conversationKey, sessionId, adapter) =>
        this.registerMirror(channelId, conversationKey, sessionId, adapter),
      getRenderMode: (channelId, conversationKey) => this.getRenderMode(channelId, conversationKey),
      setRenderMode: (channelId, conversationKey, mode) => this.setRenderMode(channelId, conversationKey, mode),
      listProjects: (c, key) => this.listProjects(c, key),
      currentProject: (c, key) => this.currentProject(c, key),
      hasPendingProject: (c, key) => Boolean(this.getPendingProject(c, key)),
      clearPendingProject: (c, key) => this.clearPendingProject(c, key),
      useProject: (c, key, target, label) => this.useProject(c, key, target, label),
      leaveProject: (c, key, label) => this.leaveProject(c, key, label)
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
    const agent = agentId ? this.cfg.agent.agents.find((a) => a.id === agentId) : undefined;
    const titleParts = [c.label, label, agent?.name].filter(Boolean);
    const title = titleParts.join(': ');
    const { sessionId } = await this.deps.session.create({
      title,
      agentId: (agentId ?? c.agentId) as AgentId | undefined,
      origin: buildOperationSource({
        transport: 'channel',
        surface: 'im',
        client: c.type, // 'telegram' | 'slack' | … — the concrete chat tool
        instanceId: c.id // which configured channel instance
      })
    });
    this.deps.store.setActiveSession({ channelId: c.id, conversationKey: key, sessionId, label: title });
    return sessionId;
  }

  private currentProject(c: ChannelInstanceConfig, key: string): Promise<CommandProjectInfo | null> {
    const pending = this.getPendingProject(c, key);
    if (pending) return Promise.resolve({ ...pending, current: true });
    const active = this.deps.store.getActiveConversation(c.id, key);
    const projectId = active ? this.deps.store.getSession(active.activeSessionId)?.projectId : undefined;
    const project = projectId ? this.deps.store.getWorkplaceProject(projectId) : null;
    return Promise.resolve(project ? { projectId: project.id, title: project.title, current: true } : null);
  }

  private async listProjects(c: ChannelInstanceConfig, key: string): Promise<CommandProjectInfo[]> {
    const current = await this.currentProject(c, key);
    return this.deps.store
      .listWorkplaceProjects({ archived: false, state: 'active' })
      .map((project) => ({ projectId: project.id, title: project.title, current: project.id === current?.projectId }));
  }

  private async useProject(
    c: ChannelInstanceConfig,
    key: string,
    target: string,
    _label?: string
  ): Promise<CommandProjectSelection | null> {
    const projects = this.deps.store.listWorkplaceProjects({ archived: false, state: 'active' });
    const byIndex = /^\d+$/.test(target) ? projects[Number(target) - 1] : undefined;
    const titleMatches = projects.filter(
      (project) => project.title.localeCompare(target, undefined, { sensitivity: 'base' }) === 0
    );
    const project =
      byIndex ??
      projects.find((candidate) => candidate.id === target) ??
      (titleMatches.length === 1 ? titleMatches[0] : undefined);
    if (!project) return null;

    this.pendingProjects.set(this.pendingProjectKey(c, key), {
      projectId: project.id as ProjectId,
      title: project.title
    });
    this.deps.store.clearActiveConversation(c.id, key);
    const sessions = this.deps.store
      .listSessions({ projectId: project.id, archived: false, state: 'active' })
      .map((session) => ({ sessionId: session.id, label: session.title, active: false }));
    return { projectId: project.id, title: project.title, current: true, sessions };
  }

  private async leaveProject(c: ChannelInstanceConfig, key: string, label?: string): Promise<{ sessionId?: string }> {
    this.clearPendingProject(c, key);
    if (c.agentId) return { sessionId: await this.startNewSession(c, key, label) };
    this.deps.store.clearActiveConversation(c.id, key);
    return {};
  }

  private async startNewProjectSession(
    c: ChannelInstanceConfig,
    key: string,
    projectId: ProjectId,
    projectTitle: string,
    label?: string
  ): Promise<SessionId> {
    if (!this.deps.session.createProjectSession) throw new Error('channel Project navigation is unavailable');
    const title = [c.label, label, projectTitle].filter(Boolean).join(': ');
    const { sessionId } = await this.deps.session.createProjectSession({
      projectId,
      title,
      origin: buildOperationSource({
        transport: 'channel',
        surface: 'im',
        client: c.type,
        instanceId: c.id
      })
    });
    this.deps.store.setActiveSession({ channelId: c.id, conversationKey: key, sessionId, label: projectTitle });
    return sessionId;
  }

  private getPendingProject(
    c: ChannelInstanceConfig,
    key: string
  ): { projectId: ProjectId; title: string } | undefined {
    return this.pendingProjects.get(this.pendingProjectKey(c, key));
  }

  private pendingProjectKey(c: ChannelInstanceConfig, key: string): string {
    return `${c.id}\0${key}`;
  }

  private clearPendingProject(c: ChannelInstanceConfig, key: string): void {
    this.pendingProjects.delete(this.pendingProjectKey(c, key));
  }
}

/** Per-message ingress provenance for one inbound channel write: the session-origin identity this
 *  same file stamps at session creation, plus the conversation and sender the ADAPTER reported.
 *  Only the adapter knows its platform's human names, so it supplies the values; every label a
 *  reader sees is rendered by the core from these structured fields. */
function channelMessageOrigin(c: ChannelInstanceConfig, m: ChannelInbound): MessageOrigin {
  return {
    ...buildOperationSource({ transport: 'channel', surface: 'im', client: c.type, instanceId: c.id }),
    ...(m.userId ? { senderId: m.userId } : {}),
    ...(m.senderDisplay ? { senderDisplay: m.senderDisplay } : {}),
    ...(m.chatTitle ? { chatTitle: m.chatTitle } : {}),
    ...(m.chatType ? { chatType: m.chatType } : {}),
    ...(m.threadId ? { threadId: m.threadId } : {})
  };
}

export { sweepIdleBuckets } from '#/channels/helpers.ts';
