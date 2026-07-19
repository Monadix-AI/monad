import type { MeshAgentConfig, MonadConfig } from '@monad/environment';
import type {
  GetMeshAgentResponse,
  ListMeshAgentPresetsResponse,
  ListMeshAgentsResponse,
  MeshAgentView,
  OkResponse,
  UpsertMeshAgentRequest
} from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';

import { HandlerError } from '#/handlers/handler-error.ts';
import {
  getMeshAgentProviderAdapter,
  listMeshAgentPresets,
  listMeshAgentReasoningEfforts,
  listMeshAgentReasoningEffortsByModel,
  meshAgentConfigToView,
  resolveMeshAgentModelOptions
} from '#/services/mesh-agent/index.ts';

export interface MeshAgentSettingsDeps {
  config: ConfigAccess;
  meshSessions?: {
    stopAgentProvider(provider: MeshAgentView['provider']): void;
  };
}

// Sentinel returned in place of raw env values so secrets (API keys) never reach the web client /
// redux store. Secret references (`${env:…}`/`${secret:…}`) are pointers, not secrets, so they stay
// visible. On upsert an unchanged sentinel is restored to the stored value (redactEnvForView ⇄
// restoreRedactedEnv), so a list→edit→save round-trip never overwrites a real secret with the mask.
const REDACTED_ENV = '••••••';
const isSecretRef = (value: string): boolean => /^\$\{(?:env|secret):[^}]+\}$/.test(value);

function redactEnvForView(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, isSecretRef(v) ? v : REDACTED_ENV]));
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

const toView = (a: MeshAgentConfig): MeshAgentView => {
  const adapter = getMeshAgentProviderAdapter(a.provider);
  const baseView = meshAgentConfigToView(a);
  const modelOptions = resolveMeshAgentModelOptions(baseView);
  const view: MeshAgentView = {
    ...baseView,
    env: redactEnvForView(a.env),
    ...modelOptions,
    reasoningEfforts: listMeshAgentReasoningEfforts(baseView),
    reasoningEffortsByModel: listMeshAgentReasoningEffortsByModel(baseView)
  };
  return { ...view, settings: adapter.settings?.(view) };
};

const fromView = (v: MeshAgentView, stored?: MeshAgentConfig): MeshAgentConfig => ({
  name: v.name,
  provider: v.provider,
  command: v.command,
  args: v.args,
  env: restoreRedactedEnv(v.env, stored?.env),
  enabled: v.enabled,
  allowAutopilot: v.allowAutopilot,
  approvalOwnership: 'provider-owned',
  projectTemplates: v.projectTemplates,
  adapterSettings: v.adapterSettings
});

export function createMeshAgentSettingsModule({ config, meshSessions }: MeshAgentSettingsDeps) {
  async function read(): Promise<MonadConfig> {
    return structuredClone(config.get().cfg);
  }
  const commit = (cfg: MonadConfig): Promise<unknown> => config.updateConfig(() => cfg);

  return {
    async listMeshAgents(): Promise<ListMeshAgentsResponse> {
      const cfg = await read();
      return { agents: cfg.meshAgents.map(toView) };
    },

    async getMeshAgent({ name }: { name: string }): Promise<GetMeshAgentResponse> {
      const cfg = await read();
      const found = cfg.meshAgents.find((a) => a.name === name);
      if (!found) throw new HandlerError('not_found', `MeshAgent not found: ${name}`);
      return { agent: toView(found) };
    },

    async listMeshAgentPresets(): Promise<ListMeshAgentPresetsResponse> {
      return { presets: await listMeshAgentPresets() };
    },

    async upsertMeshAgent({ agent }: UpsertMeshAgentRequest): Promise<OkResponse> {
      // agent is already validated by meshAgentViewSchema (command shape, env keys/NUL) at the
      // wire boundary. Restore any masked env value from the existing entry so a list→save round-trip
      // doesn't clobber stored secrets.
      const cfg = await read();
      const stored = cfg.meshAgents.find((a) => a.name === agent.name);
      cfg.meshAgents = [...cfg.meshAgents.filter((a) => a.name !== agent.name), fromView(agent, stored)];
      await commit(cfg);
      if (!agent.enabled) meshSessions?.stopAgentProvider(agent.provider);
      return { ok: true };
    },

    async setMeshAgentEnabled({ name, enabled }: { name: string; enabled: boolean }): Promise<OkResponse> {
      const cfg = await read();
      const target = cfg.meshAgents.find((a) => a.name === name);
      if (!target) throw new HandlerError('not_found', `MeshAgent not found: ${name}`);
      cfg.meshAgents = cfg.meshAgents.map((a) => (a.name === name ? { ...a, enabled } : a));
      await commit(cfg);
      if (!enabled) meshSessions?.stopAgentProvider(target.provider);
      return { ok: true };
    },

    async removeMeshAgent({ name }: { name: string }): Promise<OkResponse> {
      const cfg = await read();
      const target = cfg.meshAgents.find((a) => a.name === name);
      if (!target) throw new HandlerError('not_found', `MeshAgent not found: ${name}`);
      cfg.meshAgents = cfg.meshAgents.filter((a) => a.name !== name);
      await commit(cfg);
      meshSessions?.stopAgentProvider(target.provider);
      return { ok: true };
    }
  };
}
