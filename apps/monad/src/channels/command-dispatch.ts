import type { ChannelInstanceConfig } from '@monad/environment';
import type { ChannelInbound, SessionId } from '@monad/protocol';
import type { ChannelAdapter } from '@monad/sdk-atom';
import type { ChannelRoute, ChannelServiceDeps, ChannelTranslate, Instance } from '#/channels/types.ts';

import { errMsg } from '#/channels/helpers.ts';
import { type ChannelRenderMode, createRenderer } from '#/channels/render.ts';
import {
  type CommandBundle,
  type CommandExecution,
  type CommandServices,
  emitCommandTurn,
  executeCommand,
  type SessionNavigator
} from '#/handlers/commands/index.ts';

const CHANNEL_BLOCKED_COMMANDS = new Set(['workdir']);

export interface CommandHost {
  deps: ChannelServiceDeps;
  channelT: ChannelTranslate;
  instances: Map<string, Instance>;
  resolveSession(
    c: ChannelInstanceConfig,
    key: string,
    label?: string,
    agentId?: string,
    role?: ChannelRoute['kind']
  ): Promise<SessionId>;
  startNewSession(
    c: ChannelInstanceConfig,
    key: string,
    label?: string,
    agentId?: string,
    role?: ChannelRoute['kind']
  ): Promise<SessionId>;
  registerMirror(channelId: string, conversationKey: string, sessionId: SessionId, adapter: ChannelAdapter): void;
  getRenderMode(channelId: string, conversationKey: string): ChannelRenderMode;
  setRenderMode(channelId: string, conversationKey: string, mode: ChannelRenderMode): void;
}

/** Dispatch one in-band command through the unified registry with a conversation-keyed navigator.
 *  Returns false when the text isn't a host command (→ caller routes it to the agent). */
export async function runCommand(
  host: CommandHost,
  inst: Instance,
  c: ChannelInstanceConfig,
  key: string,
  m: ChannelInbound
): Promise<boolean> {
  if (!inst.adapter) return false;
  const bundle = host.deps.commands;
  if (!bundle) return false;
  const sessionId = await host.resolveSession(c, key, m.senderDisplay);
  const text = `/${m.command}${m.commandArgs.length ? ` ${m.commandArgs.join(' ')}` : ''}`;
  const approve = bundle.approveHighRisk;
  const exec: CommandExecution = {
    registry: bundle.registry,
    navigator: conversationNavigator(host, c, key, m.senderDisplay),
    // The channel serializes per conversation (one run at a time), so a command never races an
    // in-flight turn → not busy.
    isBusy: false,
    denyCommand: (def) =>
      CHANNEL_BLOCKED_COMMANDS.has(def.name)
        ? { message: `/${def.name} is only available from the local Monad UI or CLI.` }
        : null,
    gate: approve ? (def) => approve(sessionId, def) : undefined,
    services: channelServices(host, bundle)
  };
  const result = await executeCommand(exec, sessionId, text);
  if (result === null) return false;
  if (result.effect?.type === 'observation-render-mode-changed') {
    host.setRenderMode(c.id, key, result.effect.mode);
  }

  // Render the directive reply to IM (renderer turns the agent.message event into adapter.send),
  // and publish to the bus so cross-client viewers see the same turn.
  const renderer = createRenderer({
    adapter: inst.adapter,
    chatId: m.chatId,
    threadId: m.threadId,
    log: (level, msg) => host.deps.log[level](`[${c.id}] ${msg}`),
    t: host.channelT,
    renderMode: host.getRenderMode(c.id, key)
  });
  emitCommandTurn(
    host.deps.store,
    (e) => {
      host.deps.bus.publish(e);
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
      .catch((err) => host.deps.log.warn(`channel "${c.id}": react failed: ${errMsg(err)}`));
  }
  return true;
}

// Channels are always session-scoped (a conversation maps to a real chat session, never a Workplace
// Project id), so `sid` is cast to `SessionId` at each `bundle.*`/`session.*` call below.
function channelServices(host: CommandHost, bundle: CommandBundle): CommandServices {
  return {
    archiveSession: (sid) =>
      host.deps.session.update
        ? host.deps.session.update({ id: sid as SessionId, archived: true }).then(() => undefined)
        : Promise.reject(new Error('archive is unavailable')),
    resetHistory: (sid) =>
      host.deps.session.reset
        ? host.deps.session.reset({ id: sid as SessionId })
        : Promise.reject(new Error('reset is unavailable')),
    compact: (sid) => bundle.compact(sid as SessionId),
    consolidate: (level?: number) => bundle.consolidate(level),
    explainBelief: (sid, query) => bundle.explainBelief(sid as SessionId, query),
    checkMemory: () => bundle.checkMemory(),
    listModels: (sid) => bundle.listModels(sid as SessionId),
    setModel: (sid, alias) => bundle.setModel(sid as SessionId, alias),
    setEffort: (sid, effort) => bundle.setEffort(sid as SessionId, effort),
    getWorkdir: async (sid) => ({ path: host.deps.store.getSession(sid)?.cwd }),
    setWorkdir: (sid, path) =>
      host.deps.session.setWorkspace
        ? host.deps.session.setWorkspace({ id: sid as SessionId, cwd: path }).then((r) => ({ path: r.cwd }))
        : Promise.reject(new Error('setWorkspace is unavailable')),
    handoff: (sid, initialTask) => bundle.handoff(sid as SessionId, initialTask),
    listCommands: async () => bundle.registry.list(bundle.skills(), host.deps.t),
    t: host.deps.t,
    log: bundle.log
  };
}

/** Conversation-keyed navigator: a single chat multiplexes many sessions via the store's
 *  conversation mapping (the channel's session model, distinct from generic transports). */
function conversationNavigator(
  host: CommandHost,
  c: ChannelInstanceConfig,
  key: string,
  label?: string
): SessionNavigator {
  const { store } = host.deps;
  const channelId = c.id;
  return {
    newSession: async (l) => ({ sessionId: await host.startNewSession(c, key, l ?? label) }),
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
        sessionId: found.sessionId
      });
      // Register a mirror for the switched-to session so web-UI messages are immediately mirrored.
      const adapter = host.instances.get(channelId)?.adapter;
      if (adapter) host.registerMirror(channelId, key, found.sessionId as SessionId, adapter);
      return { sessionId: found.sessionId, label: found.label ?? undefined, active: true };
    }
  };
}
