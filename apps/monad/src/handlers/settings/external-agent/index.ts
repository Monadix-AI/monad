import type { ExternalAgentConfig, MonadConfig } from '@monad/environment';
import type {
  ExternalAgentView,
  GetExternalAgentResponse,
  ListExternalAgentPresetsResponse,
  ListExternalAgentsResponse,
  OkResponse,
  UpsertExternalAgentRequest
} from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';

import { HandlerError } from '#/handlers/handler-error.ts';
import {
  externalAgentConfigToView,
  getExternalAgentProviderAdapter,
  listExternalAgentPresets,
  listExternalAgentReasoningEfforts,
  listExternalAgentReasoningEffortsByModel,
  resolveExternalAgentModelOptions
} from '#/services/external-agent/index.ts';

export interface ExternalAgentSettingsDeps {
  config: ConfigAccess;
  externalAgentSessions?: {
    stopAgentProvider(provider: ExternalAgentView['provider']): void;
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

const toView = (a: ExternalAgentConfig): ExternalAgentView => {
  const adapter = getExternalAgentProviderAdapter(a.provider);
  const baseView = externalAgentConfigToView(a);
  const modelOptions = resolveExternalAgentModelOptions(baseView);
  const view: ExternalAgentView = {
    ...baseView,
    env: redactEnvForView(a.env),
    ...modelOptions,
    reasoningEfforts: listExternalAgentReasoningEfforts(baseView),
    reasoningEffortsByModel: listExternalAgentReasoningEffortsByModel(baseView)
  };
  return { ...view, settings: adapter.settings?.(view) };
};

const fromView = (v: ExternalAgentView, stored?: ExternalAgentConfig): ExternalAgentConfig => ({
  name: v.name,
  provider: v.provider,
  command: v.command,
  args: v.args,
  env: restoreRedactedEnv(v.env, stored?.env),
  enabled: v.enabled,
  appServerTransport: v.appServerTransport,
  allowAutopilot: v.allowAutopilot,
  approvalOwnership: 'provider-owned',
  projectTemplates: v.projectTemplates,
  adapterSettings: v.adapterSettings
});

export function createExternalAgentSettingsModule({ config, externalAgentSessions }: ExternalAgentSettingsDeps) {
  async function read(): Promise<MonadConfig> {
    return structuredClone(config.get().cfg);
  }
  const commit = (cfg: MonadConfig): Promise<unknown> => config.updateConfig(() => cfg);

  return {
    async listExternalAgents(): Promise<ListExternalAgentsResponse> {
      const cfg = await read();
      return { agents: cfg.externalAgents.map(toView) };
    },

    async getExternalAgent({ name }: { name: string }): Promise<GetExternalAgentResponse> {
      const cfg = await read();
      const found = cfg.externalAgents.find((a) => a.name === name);
      if (!found) throw new HandlerError('not_found', `external agent not found: ${name}`);
      return { agent: toView(found) };
    },

    async listExternalAgentPresets(): Promise<ListExternalAgentPresetsResponse> {
      return { presets: await listExternalAgentPresets() };
    },

    async upsertExternalAgent({ agent }: UpsertExternalAgentRequest): Promise<OkResponse> {
      // agent is already validated by externalAgentViewSchema (command shape, env keys/NUL) at the
      // wire boundary. Restore any masked env value from the existing entry so a list→save round-trip
      // doesn't clobber stored secrets.
      const cfg = await read();
      const stored = cfg.externalAgents.find((a) => a.name === agent.name);
      cfg.externalAgents = [...cfg.externalAgents.filter((a) => a.name !== agent.name), fromView(agent, stored)];
      await commit(cfg);
      if (!agent.enabled) externalAgentSessions?.stopAgentProvider(agent.provider);
      return { ok: true };
    },

    async setExternalAgentEnabled({ name, enabled }: { name: string; enabled: boolean }): Promise<OkResponse> {
      const cfg = await read();
      const target = cfg.externalAgents.find((a) => a.name === name);
      if (!target) throw new HandlerError('not_found', `external agent not found: ${name}`);
      cfg.externalAgents = cfg.externalAgents.map((a) => (a.name === name ? { ...a, enabled } : a));
      await commit(cfg);
      if (!enabled) externalAgentSessions?.stopAgentProvider(target.provider);
      return { ok: true };
    },

    async removeExternalAgent({ name }: { name: string }): Promise<OkResponse> {
      const cfg = await read();
      const target = cfg.externalAgents.find((a) => a.name === name);
      if (!target) throw new HandlerError('not_found', `external agent not found: ${name}`);
      cfg.externalAgents = cfg.externalAgents.filter((a) => a.name !== name);
      await commit(cfg);
      externalAgentSessions?.stopAgentProvider(target.provider);
      return { ok: true };
    }
  };
}
