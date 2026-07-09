import type { NetworkSettings } from '@monad/protocol';

export type LocalHttpFallbackState = 'disabled' | 'listening' | 'unavailable';

export function localHttpFallbackState(settings: NetworkSettings | undefined): LocalHttpFallbackState {
  if (settings?.localHttpFallback.enabled !== true) return 'disabled';
  const port = settings.localHttpFallback.port;
  const listeners = settings.runtime?.listeners;
  if (!listeners) return 'listening';
  return listeners.some(
    (listener) => listener.scheme === 'http' && listener.host === '127.0.0.1' && listener.port === port
  )
    ? 'listening'
    : 'unavailable';
}

export function localHttpFallbackUrl(settings: NetworkSettings | undefined): string | null {
  return localHttpFallbackState(settings) === 'listening'
    ? `http://127.0.0.1:${settings?.localHttpFallback.port ?? 52780}`
    : null;
}
