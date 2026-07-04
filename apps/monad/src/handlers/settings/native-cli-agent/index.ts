import type { MonadConfig, MonadPaths, NativeCliAgentConfig } from '@monad/home';
import type {
  ListNativeCliAgentPresetsResponse,
  ListNativeCliAgentsResponse,
  ListNativeCliSettingsImportCandidatesResponse,
  NativeCliAgentView,
  NativeCliSettingsImportApplyRequest,
  NativeCliSettingsImportApplyResult,
  NativeCliSettingsImportItem,
  NativeCliSettingsImportPreview,
  NativeCliSettingsImportPreviewRequest,
  OkResponse,
  UpsertNativeCliAgentRequest
} from '@monad/protocol';

import { createHash } from 'node:crypto';
import { loadAll, saveSystemConfig } from '@monad/home';

import { HandlerError } from '@/handlers/handler-error.ts';
import { defaultBinProbes } from '@/infra/resolve-binary.ts';
import {
  getNativeCliProviderAdapter,
  listNativeCliAgentModelOptions,
  listNativeCliAgentPresets,
  listNativeCliAgentReasoningEfforts,
  listNativeCliAgentReasoningEffortsByModel
} from '@/services/native-cli/index.ts';

export interface NativeCliAgentDeps {
  paths: MonadPaths;
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

const toView = (a: NativeCliAgentConfig): NativeCliAgentView => ({
  name: a.name,
  provider: a.provider,
  productIcon: getNativeCliProviderAdapter(a.provider).productIcon,
  command: a.command,
  args: a.args,
  env: redactEnvForView(a.env),
  modelOptions: listNativeCliAgentModelOptions(a),
  reasoningEfforts: listNativeCliAgentReasoningEfforts(a),
  reasoningEffortsByModel: listNativeCliAgentReasoningEffortsByModel(a),
  enabled: a.enabled,
  defaultLaunchMode: a.defaultLaunchMode,
  appServerTransport: a.appServerTransport,
  allowDangerousMode: a.allowDangerousMode,
  approvalOwnership: 'provider-owned'
});

const fromView = (v: NativeCliAgentView, stored?: NativeCliAgentConfig): NativeCliAgentConfig => ({
  name: v.name,
  provider: v.provider,
  command: v.command,
  args: v.args,
  modelOptions: v.modelOptions,
  env: restoreRedactedEnv(v.env, stored?.env),
  enabled: v.enabled,
  defaultLaunchMode: v.defaultLaunchMode,
  appServerTransport: v.appServerTransport,
  allowDangerousMode: v.allowDangerousMode,
  approvalOwnership: 'provider-owned'
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

function itemHash(item: Omit<NativeCliSettingsImportItem, 'hash'>): string {
  return createHash('sha256').update(stableJson(item)).digest('hex');
}

function rehashItem(item: NativeCliSettingsImportItem): NativeCliSettingsImportItem {
  const { hash: _hash, ...rest } = item;
  return { ...rest, hash: itemHash(rest) };
}

function planNativeCliSettingsImport(
  preview: NativeCliSettingsImportPreview,
  cfg: MonadConfig,
  replace: boolean
): NativeCliSettingsImportPreview {
  const existing = new Set(cfg.nativeCliAgents.map((agent) => agent.name));
  return {
    ...preview,
    items: preview.items.map((item) => {
      if (item.category !== 'nativeCliAgents' || item.action !== 'add' || !existing.has(item.target)) return item;
      return rehashItem({
        ...item,
        action: replace ? 'update' : 'conflict',
        reason: replace ? `${item.target} exists and replace allows update` : `${item.target} already exists`
      });
    })
  };
}

export function createNativeCliAgentModule({ paths }: NativeCliAgentDeps) {
  async function read(): Promise<MonadConfig> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('native-cli-agent settings: config.json missing');
    return cfg;
  }
  const commit = (cfg: MonadConfig): Promise<void> => saveSystemConfig(paths.config, cfg);

  return {
    async listNativeCliAgents(): Promise<ListNativeCliAgentsResponse> {
      const cfg = await read();
      return { agents: cfg.nativeCliAgents.map(toView) };
    },

    listNativeCliAgentPresets(): ListNativeCliAgentPresetsResponse {
      return { presets: listNativeCliAgentPresets() };
    },

    listNativeCliSettingsImportCandidates({ name }: { name: string }): ListNativeCliSettingsImportCandidatesResponse {
      const adapter = getNativeCliProviderAdapter(name);
      return { candidates: adapter.settingsImport?.detect(defaultBinProbes) ?? [] };
    },

    async previewNativeCliSettingsImport({
      name,
      request
    }: {
      name: string;
      request: NativeCliSettingsImportPreviewRequest;
    }): Promise<NativeCliSettingsImportPreview> {
      const cfg = await read();
      const adapter = getNativeCliProviderAdapter(name);
      if (!adapter.settingsImport) {
        throw new HandlerError('invalid', `native CLI provider "${name}" does not support settings import`);
      }
      return planNativeCliSettingsImport(await adapter.settingsImport.preview(request), cfg, request.replace);
    },

    async applyNativeCliSettingsImport({
      name,
      request
    }: {
      name: string;
      request: NativeCliSettingsImportApplyRequest;
    }): Promise<NativeCliSettingsImportApplyResult> {
      const cfg = await read();
      const adapter = getNativeCliProviderAdapter(name);
      if (!adapter.settingsImport) {
        throw new HandlerError('invalid', `native CLI provider "${name}" does not support settings import`);
      }
      const preview = planNativeCliSettingsImport(await adapter.settingsImport.preview(request), cfg, request.replace);
      const selected = new Set(request.select);
      const applied: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];
      let wrote = false;

      for (const item of preview.items.filter((entry) => selected.has(entry.id))) {
        if (request.hashes[item.id] !== item.hash) {
          skipped.push({ id: item.id, reason: 'preview item changed since selection' });
          continue;
        }
        if (item.category !== 'nativeCliAgents' || !item.agent) {
          skipped.push({ id: item.id, reason: 'item is not a native CLI agent setting' });
          continue;
        }
        if (item.action !== 'add' && item.action !== 'update') {
          skipped.push({ id: item.id, reason: `item action is ${item.action}` });
          continue;
        }
        const stored = cfg.nativeCliAgents.find((agent) => agent.name === item.agent?.name);
        cfg.nativeCliAgents = [
          ...cfg.nativeCliAgents.filter((agent) => agent.name !== item.agent?.name),
          fromView(item.agent, stored)
        ];
        applied.push(item.id);
        wrote = true;
      }

      if (wrote) await commit(cfg);
      return { preview, applied, skipped };
    },

    async upsertNativeCliAgent({ agent }: UpsertNativeCliAgentRequest): Promise<OkResponse> {
      // agent is already validated by nativeCliAgentViewSchema (command shape, env keys/NUL) at the
      // wire boundary. Restore any masked env value from the existing entry so a list→save round-trip
      // doesn't clobber stored secrets.
      const cfg = await read();
      const stored = cfg.nativeCliAgents.find((a) => a.name === agent.name);
      cfg.nativeCliAgents = [...cfg.nativeCliAgents.filter((a) => a.name !== agent.name), fromView(agent, stored)];
      await commit(cfg);
      return { ok: true };
    },

    async setNativeCliAgentEnabled({ name, enabled }: { name: string; enabled: boolean }): Promise<OkResponse> {
      const cfg = await read();
      cfg.nativeCliAgents = cfg.nativeCliAgents.map((a) => (a.name === name ? { ...a, enabled } : a));
      await commit(cfg);
      return { ok: true };
    },

    async removeNativeCliAgent({ name }: { name: string }): Promise<OkResponse> {
      const cfg = await read();
      cfg.nativeCliAgents = cfg.nativeCliAgents.filter((a) => a.name !== name);
      await commit(cfg);
      return { ok: true };
    }
  };
}
