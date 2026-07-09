'use client';

export interface RemoteDaemonConnection {
  id: string;
  label: string;
  lastConnectedAt: string;
  url: string;
  version?: string;
}

export interface ActiveDaemonConnection {
  id: string;
  label: string;
  type: 'local' | 'remote';
  url: string;
}

export const LOCAL_DAEMON_ID = 'local';
export const REMOTE_URL_KEY = 'monad:remoteUrl';
export const REMOTE_TOKEN_KEY = 'monad:remoteToken';

const DAEMON_CONNECTIONS_KEY = 'monad:daemonConnections';

function storage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

export interface DaemonUrlMessages {
  empty: string;
  invalid: string;
  protocol: string;
  host: string;
  clean: string;
}

const DEFAULT_DAEMON_URL_MESSAGES: DaemonUrlMessages = {
  clean: 'Use only the protocol, host, port, and optional path.',
  empty: 'Enter the Monad Daemon URL.',
  host: 'Include a hostname or IP address.',
  invalid: 'Enter a valid URL.',
  protocol: 'Use a URL that starts with http:// or https://.'
};

export function normalizeDaemonUrl(
  input: string,
  messages: DaemonUrlMessages = DEFAULT_DAEMON_URL_MESSAGES
): { error: string; url?: never } | { error?: never; url: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: messages.empty };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: messages.invalid };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: messages.protocol };
  }
  if (!parsed.hostname) return { error: messages.host };
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { error: messages.clean };
  }

  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return { url: `${parsed.origin}${pathname}` };
}

function daemonConnectionId(url: string): string {
  return `remote:${url}`;
}

export function daemonDisplayHost(url: string): string {
  try {
    const parsed = new URL(url, typeof window === 'undefined' ? 'http://127.0.0.1' : window.location.origin);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
      return 'Local';
    }
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'Daemon';
  }
}

export function readRemoteDaemonConnections(): RemoteDaemonConnection[] {
  const localStorage = storage();
  if (!localStorage) return [];

  const raw = localStorage.getItem(DAEMON_CONNECTIONS_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as RemoteDaemonConnection[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (connection) =>
        typeof connection?.id === 'string' &&
        typeof connection.label === 'string' &&
        typeof connection.url === 'string' &&
        typeof connection.lastConnectedAt === 'string'
    );
  } catch {
    return [];
  }
}

export function saveRemoteDaemonConnection(connection: {
  label?: string;
  url: string;
  version?: string;
}): RemoteDaemonConnection {
  const localStorage = storage();
  const saved: RemoteDaemonConnection = {
    id: daemonConnectionId(connection.url),
    label: connection.label || daemonDisplayHost(connection.url),
    lastConnectedAt: new Date().toISOString(),
    url: connection.url,
    version: connection.version
  };

  if (!localStorage) return saved;

  const nextConnections = [
    saved,
    ...readRemoteDaemonConnections().filter((existing) => existing.id !== saved.id)
  ].slice(0, 12);

  localStorage.setItem(DAEMON_CONNECTIONS_KEY, JSON.stringify(nextConnections));
  return saved;
}

export function activateRemoteDaemonConnection(connection: { url: string }): void {
  const localStorage = storage();
  if (!localStorage) return;
  localStorage.setItem(REMOTE_URL_KEY, connection.url);
}

export function activateLocalDaemonConnection(): void {
  const localStorage = storage();
  if (!localStorage) return;
  localStorage.removeItem(REMOTE_URL_KEY);
  localStorage.removeItem(REMOTE_TOKEN_KEY);
}

export function getActiveDaemonConnection(baseUrl: string): ActiveDaemonConnection {
  const remoteUrl = storage()?.getItem(REMOTE_URL_KEY)?.trim();
  if (remoteUrl) {
    return {
      id: daemonConnectionId(remoteUrl),
      label: daemonDisplayHost(remoteUrl),
      type: 'remote',
      url: remoteUrl
    };
  }

  return {
    id: LOCAL_DAEMON_ID,
    label: daemonDisplayHost(baseUrl),
    type: 'local',
    url: baseUrl
  };
}
