import { createMonadStore, createMonadTreatyClient, type MonadApiError } from '@monad/client-rtk';

import { toast } from '#/components/ToastProvider';
import { REMOTE_TOKEN_KEY, REMOTE_URL_KEY } from './daemon-connections';

export { REMOTE_URL_KEY } from './daemon-connections';

export interface MonadConnectionConfig {
  baseUrl: string;
  token?: string;
  wsBaseUrl?: string;
}

declare const __MONAD_WEB_PORT__: string | undefined;

const ERROR_DETAIL_LIMIT = 3000;
const UPGRADE_RESTART_SUPPRESS_UNTIL_KEY = 'monad:upgradeRestartSuppressUntil';
let upgradeReloadWatcher: number | null = null;
let daemonRestartReloadWatcher: number | null = null;

function truncate(value: string, limit = ERROR_DETAIL_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}\n… truncated` : value;
}

function compactErrorPath(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const path = (error as { path?: unknown }).path;
  if (!Array.isArray(path) || path.length === 0) return null;
  return path.map(String).join('.');
}

function compactRaw(raw: unknown): unknown {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw !== 'object') return truncate(String(raw));

  const record = raw as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of ['type', 'on', 'property', 'message', 'error', 'code']) {
    if (record[key] !== undefined) compact[key] = record[key];
  }
  if (Array.isArray(record.errors)) {
    compact.errorCount = record.errors.length;
    compact.errorPaths = record.errors.slice(0, 8).map(compactErrorPath).filter(Boolean);
  }

  if (Object.keys(compact).length > 0) return compact;
  return truncate(JSON.stringify(raw, null, 2));
}

function parseErrorMessage(message: string): Record<string, unknown> | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parsedPayloadFromApiError(err: MonadApiError): Record<string, unknown> | null {
  const fromMessage = parseErrorMessage(err.message);
  if (fromMessage) return fromMessage;

  if (!err.raw || typeof err.raw !== 'object') return null;
  const raw = err.raw as Record<string, unknown>;
  for (const key of ['message', 'error']) {
    const value = raw[key];
    if (typeof value === 'string') {
      const parsed = parseErrorMessage(value);
      if (parsed) return parsed;
    }
  }
  return raw;
}

function toastMessageForApiError(err: MonadApiError): string {
  const source = parsedPayloadFromApiError(err);
  if (source) {
    const msg = typeof source.message === 'string' ? source.message : undefined;
    const property = typeof source.property === 'string' ? source.property : undefined;
    const type = typeof source.type === 'string' ? source.type : undefined;
    if (msg && property)
      return `${type === 'validation' ? 'Validation error' : 'Request failed'}: ${property} — ${msg}`;
    if (msg) return msg;
  }

  return truncate(err.message, 220);
}

function toastDetailForApiError(err: MonadApiError): unknown {
  const parsed = parsedPayloadFromApiError(err);
  return {
    message: toastMessageForApiError(err),
    ...(err.status !== undefined ? { status: err.status } : {}),
    ...(err.code ? { code: err.code } : {}),
    raw: compactRaw(parsed ?? err.raw)
  };
}

function markUpgradeRestartWindow(durationMs = 120_000): void {
  localStorage.setItem(UPGRADE_RESTART_SUPPRESS_UNTIL_KEY, String(Date.now() + durationMs));
}

export function watchUpgradeRestartAndReload(args: {
  baseUrl: string;
  currentVersion?: string;
  targetVersion?: string | null;
}): void {
  markUpgradeRestartWindow();
  if (upgradeReloadWatcher !== null) window.clearInterval(upgradeReloadWatcher);

  const targetVersion = args.targetVersion ?? undefined;
  const currentVersion = args.currentVersion;
  const deadline = Date.now() + 120_000;
  upgradeReloadWatcher = window.setInterval(async () => {
    if (Date.now() > deadline) {
      if (upgradeReloadWatcher !== null) window.clearInterval(upgradeReloadWatcher);
      upgradeReloadWatcher = null;
      return;
    }
    try {
      const res = await fetch(`${args.baseUrl}/health`, { cache: 'no-store' });
      if (!res.ok) return;
      const health = (await res.json()) as { version?: string };
      const upgraded = targetVersion
        ? health.version === targetVersion
        : health.version && health.version !== currentVersion;
      if (!upgraded) return;
      if (upgradeReloadWatcher !== null) window.clearInterval(upgradeReloadWatcher);
      upgradeReloadWatcher = null;
      localStorage.removeItem(UPGRADE_RESTART_SUPPRESS_UNTIL_KEY);
      window.location.reload();
    } catch {
      return;
    }
  }, 1000);
}

export function nextDaemonRestartObservation(
  sawUnavailable: boolean,
  healthy: boolean
): { reload: boolean; sawUnavailable: boolean } {
  const nextSawUnavailable = sawUnavailable || !healthy;
  return { reload: healthy && sawUnavailable, sawUnavailable: nextSawUnavailable };
}

export function watchDaemonRestartAndReload(args: { baseUrl: string; onTimeout?: () => void }): () => void {
  markUpgradeRestartWindow();
  if (daemonRestartReloadWatcher !== null) window.clearInterval(daemonRestartReloadWatcher);

  let sawUnavailable = false;
  let requestInFlight = false;
  const deadline = Date.now() + 120_000;
  const stop = () => {
    if (daemonRestartReloadWatcher !== null) window.clearInterval(daemonRestartReloadWatcher);
    daemonRestartReloadWatcher = null;
  };

  daemonRestartReloadWatcher = window.setInterval(async () => {
    if (requestInFlight) return;
    if (Date.now() > deadline) {
      stop();
      localStorage.removeItem(UPGRADE_RESTART_SUPPRESS_UNTIL_KEY);
      args.onTimeout?.();
      return;
    }

    requestInFlight = true;
    let healthy = false;
    try {
      const response = await fetch(`${args.baseUrl}/health`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(1500)
      });
      healthy = response.ok;
    } catch {
      healthy = false;
    } finally {
      requestInFlight = false;
    }

    const observation = nextDaemonRestartObservation(sawUnavailable, healthy);
    sawUnavailable = observation.sawUnavailable;
    if (!observation.reload) return;

    stop();
    localStorage.removeItem(UPGRADE_RESTART_SUPPRESS_UNTIL_KEY);
    window.location.reload();
  }, 500);

  return () => {
    stop();
    localStorage.removeItem(UPGRADE_RESTART_SUPPRESS_UNTIL_KEY);
  };
}

function shouldSuppressApiErrorDuringUpgrade(err: MonadApiError): boolean {
  const until = Number(localStorage.getItem(UPGRADE_RESTART_SUPPRESS_UNTIL_KEY) ?? 0);
  if (!Number.isFinite(until) || Date.now() > until) return false;
  const status = typeof err.status === 'number' ? err.status : 0;
  return status >= 500;
}

export function resolveConnection(): MonadConnectionConfig {
  if (typeof window === 'undefined') throw new Error('resolveConnection requires a browser runtime');

  const remoteUrl = localStorage.getItem(REMOTE_URL_KEY)?.trim();
  if (remoteUrl) {
    const token = localStorage.getItem(REMOTE_TOKEN_KEY) ?? undefined;
    return { baseUrl: remoteUrl.replace(/\/$/, ''), token: token || undefined };
  }

  const localApiBase = process.env.NODE_ENV === 'development' && isViteDevOrigin(window.location.origin) ? '/api' : '';
  return { baseUrl: `${window.location.origin}${localApiBase}` };
}

function isViteDevOrigin(origin: string): boolean {
  const webPort = typeof __MONAD_WEB_PORT__ === 'string' && __MONAD_WEB_PORT__ ? __MONAD_WEB_PORT__ : '3000';
  try {
    const url = new URL(origin);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return port === webPort;
  } catch {
    return false;
  }
}

export function daemonApiUrl(baseUrl: string, path: `/${string}`): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

export function createMonadRuntime(conn: MonadConnectionConfig) {
  const client = createMonadTreatyClient({
    baseUrl: conn.baseUrl,
    wsBaseUrl: conn.wsBaseUrl,
    token: conn.token
  });
  const store = createMonadStore({
    client,
    onApiError: (err) => {
      if (shouldSuppressApiErrorDuringUpgrade(err)) return;
      toast.error(toastMessageForApiError(err), { detail: toastDetailForApiError(err) });
    }
  });

  return {
    baseUrl: conn.baseUrl,
    client,
    key: `${conn.baseUrl}|${conn.wsBaseUrl ?? ''}|${conn.token ?? ''}`,
    store,
    token: conn.token,
    wsBaseUrl: conn.wsBaseUrl
  };
}
