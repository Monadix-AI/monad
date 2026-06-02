import type { MonadConfig, MonadPaths, NativeCliAgentConfig } from '@monad/home';
import type {
  ListNativeCliAgentPresetsResponse,
  ListNativeCliAgentsResponse,
  NativeCliAgentView,
  OkResponse,
  UpsertNativeCliAgentRequest
} from '@monad/protocol';

import { loadAll, saveSystemConfig } from '@monad/home';

import { listNativeCliAgentPresets } from '@/services/native-cli/index.ts';

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
  command: a.command,
  args: a.args,
  env: redactEnvForView(a.env),
  enabled: a.enabled,
  defaultLaunchMode: a.defaultLaunchMode,
  allowDangerousMode: a.allowDangerousMode,
  approvalOwnership: 'provider-owned'
});

const fromView = (v: NativeCliAgentView, stored?: NativeCliAgentConfig): NativeCliAgentConfig => ({
  name: v.name,
  provider: v.provider,
  command: v.command,
  args: v.args,
  env: restoreRedactedEnv(v.env, stored?.env),
  enabled: v.enabled,
  defaultLaunchMode: v.defaultLaunchMode,
  allowDangerousMode: v.allowDangerousMode,
  approvalOwnership: 'provider-owned'
});

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
