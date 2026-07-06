'use client';

import { createMonadStore, createMonadTreatyClient, type MonadApiError } from '@monad/client-rtk';

import { toast } from '@/components/ToastProvider';
import { REMOTE_TOKEN_KEY, REMOTE_URL_KEY } from './daemon-connections';

export { REMOTE_TOKEN_KEY, REMOTE_URL_KEY } from './daemon-connections';

export interface MonadConnectionConfig {
  baseUrl: string;
  token?: string;
  wsBaseUrl?: string;
}

const ERROR_DETAIL_LIMIT = 3000;
const UPGRADE_RESTART_SUPPRESS_UNTIL_KEY = 'monad:upgradeRestartSuppressUntil';

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

export function markUpgradeRestartWindow(durationMs = 120_000): void {
  localStorage.setItem(UPGRADE_RESTART_SUPPRESS_UNTIL_KEY, String(Date.now() + durationMs));
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

  const apiBase = process.env.NEXT_PUBLIC_MONAD_API_BASE;
  const port = process.env.NEXT_PUBLIC_MONAD_DAEMON_PORT;
  if (apiBase) {
    return {
      baseUrl: `${window.location.origin}${apiBase}`,
      wsBaseUrl: port ? `http://127.0.0.1:${port}` : undefined
    };
  }

  // In release builds (NEXT_OUTPUT=export) the SPA is co-served with the daemon on the same port.
  if (!port) return { baseUrl: window.location.origin };
  return { baseUrl: `http://127.0.0.1:${port}` };
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
