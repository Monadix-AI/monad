'use client';

import { createMonadStore, createMonadTreatyClient } from '@monad/client-rtk';

import { toast } from '@/components/ToastProvider';
import { REMOTE_TOKEN_KEY, REMOTE_URL_KEY } from './daemon-connections';

export { REMOTE_TOKEN_KEY, REMOTE_URL_KEY } from './daemon-connections';

export interface MonadConnectionConfig {
  baseUrl: string;
  token?: string;
  wsBaseUrl?: string;
}

export function resolveConnection(): MonadConnectionConfig {
  if (typeof window === 'undefined') return { baseUrl: 'http://127.0.0.1:52749' };

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

export function createMonadRuntime(conn: MonadConnectionConfig = resolveConnection()) {
  const client = createMonadTreatyClient({
    baseUrl: conn.baseUrl,
    wsBaseUrl: conn.wsBaseUrl,
    token: conn.token
  });
  const store = createMonadStore({
    client,
    onApiError: (err) => toast.error(err.message, { detail: err })
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
