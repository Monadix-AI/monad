import type { MeshAgentConfig, MonadConfig } from '@monad/environment';
import type {
  EventPayload,
  GetMeshAgentResponse,
  ListInvitableMeshAgentsResponse,
  ListMeshAgentPresetsResponse,
  ListMeshAgentsResponse,
  MeshAgentPresetView,
  MeshAgentView,
  OkResponse,
  UpsertMeshAgentRequest
} from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';
import type { MeshAgentProbeRunner } from '#/services/mesh-agent/probe-batch.ts';

import { createLogger } from '@monad/logger';

import { HandlerError } from '#/handlers/handler-error.ts';
import { syncDiscoveredMeshAgents } from '#/services/mesh-agent/discovery.ts';
import {
  getMeshAgentProviderAdapter,
  listMeshAgentPresetFallbacks,
  listMeshAgentPresets,
  meshAgentConfigToView,
  meshAgentSettingsForAdapter,
  resolveMeshAgentCapabilities
} from '#/services/mesh-agent/index.ts';
import { invitableMeshAgentEntries, toInvitableMeshAgent } from '#/services/mesh-agent/invitable-agents.ts';

const log = createLogger('mesh-agent-settings');

export interface MeshAgentSettingsDeps {
  config: ConfigAccess;
  syncDiscoveredAgents?: typeof syncDiscoveredMeshAgents;
  probeRunner?: MeshAgentProbeRunner;
  listPresets?: typeof listMeshAgentPresets;
  presetFallbacks?: typeof listMeshAgentPresetFallbacks;
  onCatalogUpdated?: (resources: EventPayload<'mesh.catalog.updated'>['resources']) => void;
  now?: () => number;
  meshSessions?: {
    stopAgentProvider(provider: MeshAgentView['provider']): Promise<void>;
  };
}

// Sentinel returned in place of raw env values so secrets (API keys) never reach the web client /
// redux store. Environment references are pointers, not secrets, so they stay visible. On upsert
// an unchanged sentinel is restored to the stored value (redactEnvForView ⇄
// restoreRedactedEnv), so a list→edit→save round-trip never overwrites a real secret with the mask.
const REDACTED_ENV = '••••••';
const isEnvironmentRef = (value: string): boolean => /^\$\{env:[^}]+\}$/.test(value);

function redactEnvForView(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, isEnvironmentRef(v) ? v : REDACTED_ENV]));
}

function restoreRedactedEnv(
  next?: Record<string, string>,
  stored?: Record<string, string>
): Record<string, string> | undefined {
  if (!next) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(next)) {
    if (v === REDACTED_ENV) {
      // Unchanged masked value — keep what's on disk; drop the key if there's nothing to restore.
      if (stored && k in stored) out[k] = stored[k] as string;
    } else {
      out[k] = v;
    }
  }
  return out;
}

const toBaseView = (a: MeshAgentConfig): MeshAgentView => ({
  ...meshAgentConfigToView(a),
  env: redactEnvForView(a.env)
});

const withCapabilities = (
  baseView: MeshAgentView,
  capabilities: Awaited<ReturnType<typeof resolveMeshAgentCapabilities>>[number]
): MeshAgentView => {
  const adapter = getMeshAgentProviderAdapter(baseView.provider);
  const view: MeshAgentView = {
    ...baseView,
    ...capabilities
  };
  return { ...view, settings: meshAgentSettingsForAdapter(adapter, view) };
};

const enrichViews = (
  baseViews: MeshAgentView[],
  capabilities: Awaited<ReturnType<typeof resolveMeshAgentCapabilities>>
): MeshAgentView[] =>
  baseViews.map((view, index) => {
    const resolved = capabilities[index];
    if (!resolved) throw new Error(`Missing resolved capabilities for MeshAgent "${view.name}"`);
    return withCapabilities(view, resolved);
  });

const fromView = (v: MeshAgentView, stored?: MeshAgentConfig): MeshAgentConfig => {
  const supportsAutopilot = getMeshAgentProviderAdapter(v.provider).executionCapabilities?.autopilot === true;
  return {
    name: v.name,
    displayName: v.displayName,
    provider: v.provider,
    command: v.command,
    args: v.args,
    env: restoreRedactedEnv(v.env, stored?.env),
    enabled: v.enabled,
    allowAutopilot: supportsAutopilot && v.allowAutopilot,
    approvalOwnership: 'provider-owned',
    adapterSettings: v.adapterSettings,
    discovery: v.discovery
  };
};

export function createMeshAgentSettingsModule({
  config,
  listPresets = listMeshAgentPresets,
  meshSessions,
  now = Date.now,
  onCatalogUpdated,
  presetFallbacks = listMeshAgentPresetFallbacks,
  probeRunner,
  syncDiscoveredAgents = syncDiscoveredMeshAgents
}: MeshAgentSettingsDeps) {
  type Capabilities = Awaited<ReturnType<typeof resolveMeshAgentCapabilities>>;
  let capabilityCache: { key: string; value: Capabilities } | undefined;
  let presetCache: MeshAgentPresetView[] = [];
  let agentRefresh: Promise<void> | undefined;
  let presetRefresh: Promise<void> | undefined;
  let lastAgentRefreshAt = 0;
  let lastPresetRefreshAt = 0;

  try {
    presetCache = presetFallbacks();
  } catch (error) {
    log.warn({ err: error }, 'MeshAgent preset fallback discovery failed');
  }

  async function read(): Promise<MonadConfig> {
    return structuredClone(config.get().cfg);
  }
  const commit = (cfg: MonadConfig): Promise<unknown> => config.updateConfig(() => cfg);
  const agentsKey = (cfg: MonadConfig): string => JSON.stringify(cfg.meshAgents);
  const fallbackCapabilities = (views: MeshAgentView[]): Capabilities =>
    views.map((view) => {
      const adapter = getMeshAgentProviderAdapter(view.provider);
      return {
        modelOptions: adapter.modelOptions?.(view) ? [] : adapter.listSupportedModels(view),
        reasoningEfforts: []
      };
    });
  const startAgentRefresh = (current: MonadConfig, force = false): Promise<void> | undefined => {
    if (agentRefresh) return agentRefresh;
    const currentKey = agentsKey(current);
    if (!force && capabilityCache?.key === currentKey && now() - lastAgentRefreshAt < 1_000) return undefined;
    const scheduledKey = agentsKey(current);
    const pending = (async () => {
      const synced = await syncDiscoveredAgents(current);
      if (synced.changed && agentsKey(config.get().cfg) === scheduledKey) await commit(synced.cfg);
      const baseViews = synced.cfg.meshAgents.map(toBaseView);
      const next = {
        key: agentsKey(synced.cfg),
        value: await resolveMeshAgentCapabilities(baseViews, probeRunner)
      };
      const changed =
        synced.changed ||
        capabilityCache?.key !== next.key ||
        JSON.stringify(capabilityCache.value) !== JSON.stringify(next.value);
      capabilityCache = next;
      lastAgentRefreshAt = now();
      if (changed) onCatalogUpdated?.(['agents', 'invitable-agents']);
    })();
    agentRefresh = pending;
    void pending.then(
      () => {
        if (agentRefresh === pending) agentRefresh = undefined;
      },
      (error) => {
        if (agentRefresh === pending) agentRefresh = undefined;
        log.warn({ err: error }, 'MeshAgent background refresh failed');
      }
    );
    return pending;
  };
  const scheduleAgentRefresh = (current: MonadConfig): void => {
    void startAgentRefresh(current);
  };
  const currentViews = (current: MonadConfig): MeshAgentView[] => {
    const baseViews = current.meshAgents.map(toBaseView);
    const key = agentsKey(current);
    const capabilities = capabilityCache?.key === key ? capabilityCache.value : fallbackCapabilities(baseViews);
    scheduleAgentRefresh(current);
    return enrichViews(baseViews, capabilities);
  };
  const startPresetRefresh = (force = false): Promise<void> | undefined => {
    if (presetRefresh) return presetRefresh;
    if (!force && lastPresetRefreshAt > 0 && now() - lastPresetRefreshAt < 1_000) return undefined;
    const pending = (async () => {
      const next = await listPresets();
      const changed = JSON.stringify(presetCache) !== JSON.stringify(next);
      presetCache = next;
      lastPresetRefreshAt = now();
      if (changed) onCatalogUpdated?.(['presets']);
    })();
    presetRefresh = pending;
    void pending.then(
      () => {
        if (presetRefresh === pending) presetRefresh = undefined;
      },
      (error) => {
        if (presetRefresh === pending) presetRefresh = undefined;
        log.warn({ err: error }, 'MeshAgent preset background refresh failed');
      }
    );
    return pending;
  };
  const schedulePresetRefresh = (): void => {
    void startPresetRefresh();
  };

  return {
    async listMeshAgents(): Promise<ListMeshAgentsResponse> {
      const current = await read();
      return { agents: currentViews(current) };
    },

    async listInvitableMeshAgents(): Promise<ListInvitableMeshAgentsResponse> {
      const current = await read();
      const configuredByName = new Map(currentViews(current).map((agent) => [agent.name, agent]));
      return {
        agents: invitableMeshAgentEntries(current).map((entry) => {
          const configured = configuredByName.get(entry.config.name);
          const view =
            configured ?? enrichViews([toBaseView(entry.config)], fallbackCapabilities([toBaseView(entry.config)]))[0];
          if (!view) throw new Error(`Missing invitable MeshAgent view "${entry.config.name}"`);
          return toInvitableMeshAgent(view, entry.source, getMeshAgentProviderAdapter(view.provider).icon);
        })
      };
    },

    async getMeshAgent({ name }: { name: string }): Promise<GetMeshAgentResponse> {
      const cfg = await read();
      const found = cfg.meshAgents.find((a) => a.name === name);
      if (!found) throw new HandlerError('not_found', `MeshAgent not found: ${name}`);
      const baseView = toBaseView(found);
      const capabilities = await resolveMeshAgentCapabilities([baseView], probeRunner);
      const agent = enrichViews([baseView], capabilities)[0];
      if (!agent) throw new Error(`Missing enriched MeshAgent "${name}"`);
      return { agent };
    },

    async listMeshAgentPresets(): Promise<ListMeshAgentPresetsResponse> {
      const presets = presetCache;
      schedulePresetRefresh();
      return { presets };
    },

    async refreshCatalog(): Promise<OkResponse> {
      const current = await read();
      await Promise.all([startAgentRefresh(current, true), startPresetRefresh(true)]);
      return { ok: true };
    },

    async upsertMeshAgent({ agent }: UpsertMeshAgentRequest): Promise<OkResponse> {
      // agent is already validated by meshAgentViewSchema (command shape, env keys/NUL) at the
      // wire boundary. Restore any masked env value from the existing entry so a list→save round-trip
      // doesn't clobber stored secrets.
      const cfg = await read();
      const stored = cfg.meshAgents.find((a) => a.name === agent.name);
      cfg.meshAgents = [...cfg.meshAgents.filter((a) => a.name !== agent.name), fromView(agent, stored)];
      await commit(cfg);
      if (!agent.enabled) await meshSessions?.stopAgentProvider(agent.provider);
      return { ok: true };
    },

    async setMeshAgentEnabled({ name, enabled }: { name: string; enabled: boolean }): Promise<OkResponse> {
      const cfg = await read();
      const target = cfg.meshAgents.find((a) => a.name === name);
      if (!target) throw new HandlerError('not_found', `MeshAgent not found: ${name}`);
      cfg.meshAgents = cfg.meshAgents.map((a) => (a.name === name ? { ...a, enabled } : a));
      await commit(cfg);
      if (!enabled) await meshSessions?.stopAgentProvider(target.provider);
      return { ok: true };
    },

    async removeMeshAgent({ name }: { name: string }): Promise<OkResponse> {
      const cfg = await read();
      const target = cfg.meshAgents.find((a) => a.name === name);
      if (!target) throw new HandlerError('not_found', `MeshAgent not found: ${name}`);
      cfg.meshAgents = cfg.meshAgents.filter((a) => a.name !== name);
      await commit(cfg);
      await meshSessions?.stopAgentProvider(target.provider);
      return { ok: true };
    }
  };
}
