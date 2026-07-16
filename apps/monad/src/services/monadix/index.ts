import type { MonadixConfig } from '@monad/environment';
import type { MonadixRealtimeHandle } from './realtime-client.ts';

import { startMonadixRealtime } from './realtime-client.ts';
import {
  deregisterMonadixProvider,
  fetchRealtimeConfig,
  MONADIX_DEFAULT_API_BASE,
  registerMonadixProvider
} from './register.ts';

interface ProviderLogger {
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

/** One agent's provider-relevant state, derived from its config row. */
export interface MonadixProviderAgent {
  id: string;
  name: string;
  description?: string;
  isPublic: boolean;
  /** Persisted network provider id (agent.published.providerId), if already registered. */
  providerId?: string;
}

export interface MonadixProviderManagerDeps {
  getConfig(): MonadixConfig;
  /** MCP OAuth access token (from `monad monadix login`). Absent → not logged in. */
  getToken(): Promise<string | undefined>;
  /** Build the task runner for a specific agent (routes inbound tasks to it). */
  runnerFor(agentId: string): (task: { taskId: string; prompt: string }) => Promise<string>;
  persistProviderId(agentId: string, providerId: string): Promise<void>;
  clearProviderId(agentId: string): Promise<void>;
  logger: ProviderLogger;
}

interface ActiveProvider {
  providerId: string;
  handle: MonadixRealtimeHandle;
}

/**
 * Manages this daemon's Monadix provider presence, one registration + realtime subscription PER
 * public agent (`agent.visibility.public`). `sync(agents)` reconciles the live set against the
 * config: it brings up newly-public agents (auto-register if needed, then subscribe) and tears down
 * agents that were unpublished or deleted (stop subscription + deregister + clear providerId). Idempotent
 * and best-effort — a per-agent failure is logged and skipped, never thrown. Runs at boot and on every
 * config reload (a `visibility.public` toggle re-syncs without a restart). No-op unless `monadix.enabled`.
 */
export function createMonadixProviderManager(deps: MonadixProviderManagerDeps) {
  const active = new Map<string, ActiveProvider>();
  let cachedCreds: { supabaseUrl: string; supabaseAnonKey: string } | null = null;
  // sync() is re-entrant: bringUp → persistProviderId → ConfigManager.publish → hot-reload →
  // runMonadixSync → sync(). Coalesce instead of running concurrently (a blocking mutex would
  // deadlock — the outer sync awaits the write that triggers the inner one). A call while a
  // reconcile is in flight just records the latest agent set; the running loop picks it up.
  let reconciling = false;
  let latest: MonadixProviderAgent[] | null = null;

  const apiBaseOf = (config: MonadixConfig) =>
    config.baseUrl ? new URL(config.baseUrl).origin : MONADIX_DEFAULT_API_BASE;

  async function resolveCreds(config: MonadixConfig, apiBase: string) {
    if (config.supabaseUrl && config.supabaseAnonKey) {
      return { supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnonKey };
    }
    if (!cachedCreds) cachedCreds = await fetchRealtimeConfig(apiBase);
    return cachedCreds;
  }

  async function stopOne(agentId: string): Promise<void> {
    const entry = active.get(agentId);
    if (!entry) return;
    active.delete(agentId);
    await entry.handle.stop().catch(() => {});
  }

  async function stopAll(): Promise<void> {
    await Promise.all([...active.keys()].map(stopOne));
  }

  async function bringUp(
    agent: MonadixProviderAgent,
    apiBase: string,
    token: string,
    creds: { supabaseUrl: string; supabaseAnonKey: string }
  ): Promise<void> {
    let providerId = agent.providerId;
    if (!providerId) {
      providerId = await registerMonadixProvider({
        apiBase,
        token,
        name: agent.name,
        description: agent.description ?? `A Monad agent (${agent.name}) on the Monadix network.`,
        capabilities: ['general assistance']
      });
      await deps.persistProviderId(agent.id, providerId);
      deps.logger.info({ agentId: agent.id, providerId }, 'monadix: registered agent as provider');
    }
    const handle = startMonadixRealtime({
      supabaseUrl: creds.supabaseUrl,
      supabaseAnonKey: creds.supabaseAnonKey,
      providerId,
      apiBase,
      token,
      runAgent: deps.runnerFor(agent.id),
      logger: deps.logger
    });
    active.set(agent.id, { providerId, handle });
  }

  async function tearDown(agentId: string, apiBase: string, token: string, providerId?: string): Promise<void> {
    await stopOne(agentId);
    if (providerId) {
      await deregisterMonadixProvider(apiBase, token, providerId).catch((err) =>
        deps.logger.warn({ agentId, err: String(err) }, 'monadix: deregister failed')
      );
      await deps.clearProviderId(agentId).catch(() => {});
    }
  }

  async function reconcile(agents: MonadixProviderAgent[]): Promise<void> {
    const config = deps.getConfig();
    if (!config.enabled) return stopAll();
    const token = await deps.getToken();
    if (!token) {
      if (active.size) await stopAll();
      return;
    }
    const apiBase = apiBaseOf(config);
    const wantPublic = new Map(agents.filter((a) => a.isPublic).map((a) => [a.id, a]));

    // Tear down agents that are active but no longer public (or deleted).
    for (const [agentId, entry] of [...active]) {
      if (!wantPublic.has(agentId)) await tearDown(agentId, apiBase, token, entry.providerId);
    }

    // Bring up newly-public agents — independent, so in parallel (best-effort per agent).
    const pending = [...wantPublic.values()].filter((a) => !active.has(a.id));
    if (!pending.length) return;
    const creds = await resolveCreds(config, apiBase);
    if (!creds) {
      deps.logger.warn({}, 'monadix: realtime config unavailable — provider agents not brought up');
      return;
    }
    await Promise.all(
      pending.map((agent) =>
        bringUp(agent, apiBase, token, creds).catch((err) =>
          deps.logger.warn({ agentId: agent.id, err: String(err) }, 'monadix: failed to bring up provider agent')
        )
      )
    );
  }

  return {
    async sync(agents: MonadixProviderAgent[]): Promise<void> {
      latest = agents;
      if (reconciling) return;
      reconciling = true;
      try {
        while (latest) {
          const batch = latest;
          latest = null;
          await reconcile(batch);
        }
      } finally {
        reconciling = false;
      }
    },
    stopAll
  };
}
