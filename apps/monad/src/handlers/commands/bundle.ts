// Boot phase: the unified slash-command backend (CommandBundle). Wires the command registry to the
// daemon's services — model list/switch, /compact, /handoff (summarize the current session into a
// fresh one), memory + graph consolidation, and the highRisk approval gate. Returned to the channel
// gateway and the daemon handlers (see ./serve.ts / handlers.ts).

import type { MonadConfig } from '@monad/environment';
import type { Logger } from '@monad/logger';
import type { Event, SessionId } from '@monad/protocol';
import type { BeliefExplanation, ConsolidateSummary, ContradictionCheckSummary } from '@monad/sdk-atom';
import type { DurableSummarizer, ModelRouter } from '#/agent/index.ts';
import type { SessionGateway } from '#/channels/channel.ts';
import type { CommandBundle, CommandRegistry, SkillCommandView } from '#/handlers/commands/index.ts';
import type { EventBus } from '#/services/event-bus.ts';
import type { I18nService } from '#/services/i18n.ts';
import type { ModelService } from '#/services/model.ts';
import type { ModelCatalogService } from '#/services/model-catalog.ts';
import type { OversightService } from '#/services/oversight.ts';
import type { Store } from '#/store/db/index.ts';

import { newId } from '@monad/protocol';

import { HANDOFF_PROMPT, renderHandoffUserPrompt, replayHistory } from '#/agent/index.ts';

export interface CommandBundleDeps {
  commandRegistry: CommandRegistry;
  skills: () => SkillCommandView[];
  store: Store;
  cfg: MonadConfig;
  modelService: ModelService;
  modelCatalog: ModelCatalogService;
  agentModel: ModelRouter;
  history: DurableSummarizer;
  runConsolidate: (level?: number) => Promise<ConsolidateSummary>;
  explainBelief: (sessionId: string, query: string) => Promise<BeliefExplanation>;
  runCheckContradictions: () => Promise<ContradictionCheckSummary>;
  oversight: OversightService;
  i18n: I18nService;
  bus: EventBus;
  /** Late-bound: the session gateway is wired after handlers exist; /handoff guards on it being set. */
  sessionGateway: () => SessionGateway | null;
  logger: Logger;
}

export function createCommandBundle(deps: CommandBundleDeps): CommandBundle {
  const {
    commandRegistry,
    skills,
    store,
    cfg,
    modelService,
    modelCatalog,
    agentModel,
    history,
    runConsolidate,
    explainBelief,
    runCheckContradictions,
    oversight,
    i18n,
    bus,
    sessionGateway,
    logger
  } = deps;

  const publishSessionUpdated = (sessionId: SessionId): void => {
    bus.publish({
      id: newId('evt'),
      sessionId,
      type: 'session.updated',
      actorAgentId: null,
      payload: {},
      at: new Date().toISOString()
    });
  };

  // listModels marks the session's effective model (its per-session override, else the daemon
  // default); setModel persists the override (the loop reads session.model per turn). /compact still
  // degrades to a clear reply (needs an engine trigger).
  return {
    registry: commandRegistry,
    skills,
    listModels: async (sessionId) => {
      const effective = store.getSession(sessionId)?.model ?? cfg.model.default;
      return modelService.profiles.map((p) => ({
        alias: p.alias,
        provider: p.routes.chat.provider,
        modelId: p.routes.chat.modelId,
        current: p.alias === effective
      }));
    },
    setModel: async (sessionId, alias) => {
      if (alias === 'inherit') {
        if (store.updateSession(sessionId, { model: null, reasoningEffort: null })) {
          publishSessionUpdated(sessionId);
          return;
        }
        throw new Error(`Session not found: ${sessionId}`);
      }
      const separator = alias.indexOf(':');
      const rawProvider = separator > 0 && separator < alias.length - 1 ? alias.slice(0, separator) : undefined;
      const validProfile = modelService.profiles.some((p) => p.alias === alias);
      const validRawModel = rawProvider
        ? modelService.providers.some((provider) => provider.id === rawProvider)
        : false;
      if (!validProfile && !validRawModel) {
        throw new Error(`Unknown model profile: ${alias}`);
      }
      if (store.updateSession(sessionId, { model: alias, reasoningEffort: null })) {
        publishSessionUpdated(sessionId);
        return;
      }
      throw new Error(`Session not found: ${sessionId}`);
    },
    setEffort: async (sessionId, effort) => {
      const session = store.getSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      if (effort) {
        const agent = session.agentIds[0]
          ? cfg.agent.agents.find((candidate) => candidate.id === session.agentIds[0])
          : undefined;
        const agentProfile = agent?.modelAlias ?? (agent?.model && agent.model !== 'inherit' ? agent.model : undefined);
        const modelRef = session.model ?? agentProfile ?? cfg.model.default;
        const separator = modelRef.indexOf(':');
        const profile =
          separator > 0 ? undefined : modelService.profiles.find((candidate) => candidate.alias === modelRef);
        const provider = separator > 0 ? modelRef.slice(0, separator) : profile?.routes.chat.provider;
        const modelId = separator > 0 ? modelRef.slice(separator + 1) : profile?.routes.chat.modelId;
        const supported =
          provider && modelId ? modelCatalog.lookupCapabilities(provider, modelId)?.reasoningEfforts : undefined;
        if (supported && !supported.includes(effort)) {
          throw new Error(`Unsupported reasoning effort "${effort}" for ${provider}:${modelId}`);
        }
      }
      if (store.updateSession(sessionId, { reasoningEffort: effort ?? null })) {
        publishSessionUpdated(sessionId);
        return;
      }
      throw new Error(`Session not found: ${sessionId}`);
    },
    compact: async (sessionId) => {
      return history.compact(sessionId);
    },
    handoff: async (sessionId, initialTask) => {
      const gateway = sessionGateway();
      if (!gateway) throw new Error('/handoff used before session wiring');
      const session = store.getSession(sessionId);
      if (!session) throw new Error('Session not found');

      const assembled = history
        ? await history.assemble(sessionId)
        : { summary: undefined, messages: replayHistory(store.listMessages(sessionId)) };
      const transcript = assembled.messages
        .filter((m) => m.role !== 'system')
        .map((m) => {
          const raw = m.content;
          const text =
            typeof raw === 'string'
              ? raw
              : (raw as Array<{ type: string; text?: string }>)
                  .filter((p) => p.type === 'text')
                  .map((p) => p.text ?? '')
                  .join(' ');
          return text ? `${m.role}: ${text}` : null;
        })
        .filter((line): line is string => line !== null)
        .join('\n')
        .slice(0, 100_000);

      const summaryModelId =
        modelCatalog.pickProfileForTier('fast', modelService.profiles, modelService.tierOverrides) ?? cfg.model.default;
      const title = initialTask ? initialTask.slice(0, 60) : 'Continued session';
      const [{ text: handoffSummary }, { sessionId: newSessionId }] = await Promise.all([
        agentModel.complete({
          model: summaryModelId,
          sessionId,
          messages: [
            { role: 'system', content: HANDOFF_PROMPT },
            {
              role: 'user',
              content: renderHandoffUserPrompt({ prior: assembled.summary, transcript })
            }
          ]
        }),
        gateway.create({
          title,
          agentId: session.agentIds[0] ?? undefined,
          origin: session.origin
        })
      ]);

      const contextBlock = `<handoff-context>\n${handoffSummary}\n</handoff-context>`;
      const safeTask = initialTask?.slice(0, 10_000);
      const firstMessage = safeTask ? `${contextBlock}\n\n${safeTask}` : contextBlock;
      const msgId = newId('msg');
      const now = new Date().toISOString();
      store.insertMessage(msgId, newSessionId as SessionId, firstMessage, now, 'user', { type: 'text' });
      const evt: Event = {
        id: newId('evt'),
        sessionId: newSessionId as SessionId,
        type: 'user.message',
        actorAgentId: null,
        payload: { messageId: msgId, text: firstMessage },
        at: now
      };
      store.appendEvents([evt]);
      bus.publish(evt);

      return { sessionId: newSessionId };
    },
    consolidate: (level) => runConsolidate(level),
    explainBelief: (sid, query) => explainBelief(sid, query),
    checkMemory: () => runCheckContradictions(),
    // A highRisk command (e.g. a third-party atom pack command) routes through the same human-approval
    // gate as a highRisk tool call before it runs; a denial throws (surfaced as the command reply).
    approveHighRisk: async (sessionId, def) => {
      const outcome = await oversight.gate({ tool: `command:/${def.name}`, sessionId, highRisk: true, input: {} });
      if (!outcome.allow)
        throw new Error(`/${def.name} was not approved${outcome.reason ? `: ${outcome.reason}` : ''}`);
    },
    t: i18n.t,
    log: (level, msg) => logger[level](msg)
  };
}
