import type { MonadPaths } from '@monad/home';

import { join, resolve } from 'node:path';
import { type Credential, computeInitStatus, loadAll, loadAuth, saveAuth, saveProfile } from '@monad/home';
import { channelIdSchema, ModelProviderType, newId } from '@monad/protocol';
import { z } from 'zod';

// Developer-specific seed parameters live in a gitignored `config.init.json` inside packages/home —
// NEVER in the codebase. The repo only ships `config.init.json.template`; each developer copies it
// to `config.init.json` and fills in their own provider / model / API key / bot token.
const DEV_SEED_FILE = 'config.init.json';

/** packages/home-relative path of the seed file. Resolves up from apps/monad/src/store/home/ to the repo
 *  root, then into packages/home/ where the template and gitignored seed file live. */
export function defaultSeedPath(): string {
  return join(resolve(import.meta.dir, '../../../../..', 'packages', 'home'), DEV_SEED_FILE);
}

const devSeedSchema = z.object({
  provider: z
    .object({
      id: z.string().min(1).default('openrouter'),
      label: z.string().min(1).default('OpenRouter'),
      type: z.nativeEnum(ModelProviderType).default(ModelProviderType.OpenRouter)
    })
    // Full literal default: a defaulted value is NOT re-parsed, so the inner field defaults only
    // apply when `provider` is present-but-partial.
    .default({ id: 'openrouter', label: 'OpenRouter', type: ModelProviderType.OpenRouter }),
  apiKey: z.string().trim().default(''),
  model: z.string().trim().default(''),
  profileAlias: z.string().min(1).default('default'),
  // Modest reasoning budget so the web UI shows a thinking trace out of the box; ignored by models
  // that don't support reasoning.
  reasoningEffort: z.enum(['low', 'medium', 'high']).default('low'),
  telegram: z
    .object({
      channelId: channelIdSchema.default('chn_DEVTELEGRAM0'),
      botToken: z.string().trim().default('')
    })
    .optional()
});

type DevSeed = z.infer<typeof devSeedSchema>;

export type DevProviderOutcome =
  | { seeded: true; model: string }
  | { seeded: false; reason: 'no-key' | 'no-model' | 'already-initialized' | 'no-config' };

function isMissingFile(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Read + validate `config.init.json`. Missing file → null (caller falls back to env). Malformed →
 *  throws loudly so the developer fixes their seed file rather than silently skipping setup. */
async function loadDevSeed(seedPath: string): Promise<DevSeed | null> {
  let raw: string;
  try {
    raw = await Bun.file(seedPath).text();
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`monad: ${DEV_SEED_FILE} is not valid JSON at ${seedPath}. Fix the file and retry.`);
  }
  return devSeedSchema.parse(parsed);
}

/**
 * Dev convenience: auto-initialise a model provider from `config.init.json` (or the OPENROUTER_*
 * env fallback) so the web UI doesn't force a manual setup pass on every fresh `.dev/.monad`.
 *
 * No API key → no-op (the caller leaves monad uninitialised, and the web UI redirects to /init).
 * Already initialised → no-op (never clobbers a real configuration).
 *
 * `opts.apiKey` / `opts.model` override the resolved seed (used by tests). `opts.seedPath` points at
 * an alternate seed file (also tests). Only ever called from dev/non-production startup paths.
 */
export async function ensureDevProvider(
  paths: MonadPaths,
  opts: { apiKey?: string; model?: string; seedPath?: string } = {}
): Promise<DevProviderOutcome> {
  const seed = (await loadDevSeed(opts.seedPath ?? defaultSeedPath())) ?? devSeedSchema.parse({});

  const apiKey = (opts.apiKey ?? seed.apiKey ?? '').trim();
  if (!apiKey) return { seeded: false, reason: 'no-key' };

  const cfg = await loadAll(paths.config, paths.profile);
  if (!cfg) return { seeded: false, reason: 'no-config' };

  const auth = (await loadAuth(paths.auth)) ?? {
    version: 1 as const,
    activeProvider: null,
    updatedAt: new Date().toISOString(),
    credentialPool: {}
  };

  if (computeInitStatus(cfg, auth).initialized) {
    return { seeded: false, reason: 'already-initialized' };
  }

  const model = (opts.model ?? seed.model ?? '').trim();
  if (!model) return { seeded: false, reason: 'no-model' };

  const { provider, profileAlias, reasoningEffort } = seed;

  if (!cfg.model.providers.some((p) => p.id === provider.id)) {
    cfg.model.providers.push({ id: provider.id, label: provider.label, type: provider.type });
  }

  const profile = {
    alias: profileAlias,
    routes: { chat: { provider: provider.id, modelId: model } },
    params: { reasoningEffort },
    fallbacks: []
  };
  const existingProfile = cfg.model.profiles.findIndex((p) => p.alias === profileAlias);
  if (existingProfile === -1) cfg.model.profiles.push(profile);
  else cfg.model.profiles[existingProfile] = profile;
  cfg.model.default = profileAlias;

  auth.credentialPool[provider.id] ??= [];
  const pool = auth.credentialPool[provider.id] as Credential[];
  if (pool.length === 0) {
    pool.push({
      id: newId('cred'),
      label: `${provider.label} (dev seed)`,
      authType: 'api_key',
      priority: 0,
      source: 'dev-env',
      accessToken: apiKey,
      lastStatus: 'unknown',
      lastStatusAt: null,
      lastErrorCode: null,
      lastErrorReason: null,
      lastErrorMessage: null,
      lastErrorResetAt: null,
      requestCount: 0
    });
  }
  auth.updatedAt = new Date().toISOString();

  if (!cfg.agent.agents.length) {
    const agentId = newId('agt');
    cfg.agent.agents.push({
      id: agentId,
      name: 'Default Dev Agent',
      modelAlias: profileAlias,
      framework: undefined,
      capabilities: [],
      declaredScopes: [],
      atoms: { mode: 'inherit', allow: [], deny: [] },
      visibility: { subagentCallable: false, public: false },
      a2a: { enabled: false },
      monadix: { consume: false }
    });
    cfg.agent.defaultAgentId = agentId;
  }

  const telegramToken = (seed.telegram?.botToken || '').trim();
  const telegramChannelId = seed.telegram?.channelId ?? 'chn_DEVTELEGRAM0';
  if (telegramToken && !cfg.channels.some((c) => c.id === telegramChannelId)) {
    cfg.channels.push({
      id: telegramChannelId,
      type: 'telegram',
      label: 'Dev Telegram',
      enabled: true,
      options: {},
      allowlist: { policy: 'open', allowAllUsers: true, allowedUsers: [] },
      groupPolicy: { requireMention: true },
      mapping: { granularity: 'per-conversation' },
      tokenRef: `\${secret:channel/${telegramChannelId}/token}`,
      rateLimitPerMin: 20
    });
    auth.channelCredentials ??= {};
    auth.channelCredentials[telegramChannelId] = { token: telegramToken };
  }

  await saveProfile(paths.profile, cfg);
  await saveAuth(paths.auth, auth);

  return { seeded: true, model };
}
