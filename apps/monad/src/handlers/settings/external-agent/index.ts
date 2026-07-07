import type { ExternalAgentConfig, MonadConfig, MonadPaths } from '@monad/home';
import type {
  ExternalAgentSettingsImportApplyRequest,
  ExternalAgentSettingsImportApplyResult,
  ExternalAgentSettingsImportItem,
  ExternalAgentSettingsImportPreview,
  ExternalAgentSettingsImportPreviewRequest,
  ExternalAgentView,
  GetExternalAgentResponse,
  ListExternalAgentPresetsResponse,
  ListExternalAgentSettingsImportCandidatesResponse,
  ListExternalAgentsResponse,
  OkResponse,
  UpsertExternalAgentRequest
} from '@monad/protocol';

import { createHash } from 'node:crypto';
import { loadAll, saveSystemConfig } from '@monad/home';

import { HandlerError } from '@/handlers/handler-error.ts';
import { defaultBinProbes } from '@/infra/resolve-binary.ts';
import {
  getExternalAgentProviderAdapter,
  listExternalAgentModelOptions,
  listExternalAgentPresets,
  listExternalAgentReasoningEfforts,
  listExternalAgentReasoningEffortsByModel
} from '@/services/external-agent/index.ts';

export interface ExternalAgentSettingsDeps {
  paths: MonadPaths;
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
  const view: ExternalAgentView = {
    name: a.name,
    provider: a.provider,
    productIcon: adapter.productIcon,
    command: a.command,
    args: a.args,
    env: redactEnvForView(a.env),
    modelOptions: listExternalAgentModelOptions(a),
    reasoningEfforts: listExternalAgentReasoningEfforts(a),
    reasoningEffortsByModel: listExternalAgentReasoningEffortsByModel(a),
    enabled: a.enabled,
    defaultLaunchMode: a.defaultLaunchMode,
    appServerTransport: a.appServerTransport,
    allowAutopilot: a.allowAutopilot,
    approvalOwnership: 'provider-owned',
    projectTemplates: a.projectTemplates,
    adapterSettings: a.adapterSettings
  };
  return { ...view, settings: adapter.settings?.(view) };
};

const fromView = (v: ExternalAgentView, stored?: ExternalAgentConfig): ExternalAgentConfig => ({
  name: v.name,
  provider: v.provider,
  command: v.command,
  args: v.args,
  modelOptions: v.modelOptions,
  env: restoreRedactedEnv(v.env, stored?.env),
  enabled: v.enabled,
  defaultLaunchMode: v.defaultLaunchMode,
  appServerTransport: v.appServerTransport,
  allowAutopilot: v.allowAutopilot,
  approvalOwnership: 'provider-owned',
  projectTemplates: v.projectTemplates,
  adapterSettings: v.adapterSettings
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function itemHash(item: Omit<ExternalAgentSettingsImportItem, 'hash'>): string {
  return createHash('sha256').update(stableJson(item)).digest('hex');
}

function rehashItem(item: ExternalAgentSettingsImportItem): ExternalAgentSettingsImportItem {
  const { hash: _hash, ...rest } = item;
  return { ...rest, hash: itemHash(rest) };
}

function planExternalAgentSettingsImport(
  preview: ExternalAgentSettingsImportPreview,
  cfg: MonadConfig,
  replace: boolean
): ExternalAgentSettingsImportPreview {
  const existing = new Set(cfg.externalAgents.map((agent) => agent.name));
  return {
    ...preview,
    items: preview.items.map((item) => {
      if (item.category !== 'externalAgents' || item.action !== 'add' || !existing.has(item.target)) return item;
      return rehashItem({
        ...item,
        action: replace ? 'update' : 'conflict',
        reason: replace ? `${item.target} exists and replace allows update` : `${item.target} already exists`
      });
    })
  };
}

export function createExternalAgentSettingsModule({ paths, externalAgentSessions }: ExternalAgentSettingsDeps) {
  async function read(): Promise<MonadConfig> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('external-agent settings: config.json missing');
    return cfg;
  }
  const commit = (cfg: MonadConfig): Promise<void> => saveSystemConfig(paths.config, cfg);

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

    listExternalAgentPresets(): ListExternalAgentPresetsResponse {
      return { presets: listExternalAgentPresets() };
    },

    listExternalAgentSettingsImportCandidates({
      name
    }: {
      name: string;
    }): ListExternalAgentSettingsImportCandidatesResponse {
      const adapter = getExternalAgentProviderAdapter(name);
      return { candidates: adapter.settingsImport?.detect(defaultBinProbes) ?? [] };
    },

    async previewExternalAgentSettingsImport({
      name,
      request
    }: {
      name: string;
      request: ExternalAgentSettingsImportPreviewRequest;
    }): Promise<ExternalAgentSettingsImportPreview> {
      const cfg = await read();
      const adapter = getExternalAgentProviderAdapter(name);
      if (!adapter.settingsImport) {
        throw new HandlerError('invalid', `external agent provider "${name}" does not support settings import`);
      }
      return planExternalAgentSettingsImport(await adapter.settingsImport.preview(request), cfg, request.replace);
    },

    async applyExternalAgentSettingsImport({
      name,
      request
    }: {
      name: string;
      request: ExternalAgentSettingsImportApplyRequest;
    }): Promise<ExternalAgentSettingsImportApplyResult> {
      const cfg = await read();
      const adapter = getExternalAgentProviderAdapter(name);
      if (!adapter.settingsImport) {
        throw new HandlerError('invalid', `external agent provider "${name}" does not support settings import`);
      }
      const preview = planExternalAgentSettingsImport(
        await adapter.settingsImport.preview(request),
        cfg,
        request.replace
      );
      const selected = new Set(request.select);
      const applied: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];
      let wrote = false;

      for (const item of preview.items.filter((entry) => selected.has(entry.id))) {
        if (request.hashes[item.id] !== item.hash) {
          skipped.push({ id: item.id, reason: 'preview item changed since selection' });
          continue;
        }
        if (item.category !== 'externalAgents' || !item.agent) {
          skipped.push({ id: item.id, reason: 'item is not an external agent setting' });
          continue;
        }
        if (item.action !== 'add' && item.action !== 'update') {
          skipped.push({ id: item.id, reason: `item action is ${item.action}` });
          continue;
        }
        const stored = cfg.externalAgents.find((agent) => agent.name === item.agent?.name);
        cfg.externalAgents = [
          ...cfg.externalAgents.filter((agent) => agent.name !== item.agent?.name),
          fromView(item.agent, stored)
        ];
        applied.push(item.id);
        wrote = true;
      }

      if (wrote) await commit(cfg);
      return { preview, applied, skipped };
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
