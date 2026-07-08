'use client';

import { useCallback, useSyncExternalStore } from 'react';

const SHELL_LOCATION_EVENT = 'monad:shell-location';

export type ShellNavigateMode = 'push' | 'replace';

interface ShellLocationSnapshot {
  hash: string;
  pathname: string;
  search: string;
}

let cachedSnapshot: ShellLocationSnapshot | null = null;
const SERVER_SNAPSHOT: ShellLocationSnapshot = { hash: '', pathname: '/', search: '' };

function readSnapshot(): ShellLocationSnapshot {
  if (typeof window === 'undefined') return { hash: '', pathname: '/', search: '' };
  const next = {
    hash: window.location.hash,
    pathname: window.location.pathname,
    search: window.location.search
  };
  if (
    cachedSnapshot &&
    cachedSnapshot.hash === next.hash &&
    cachedSnapshot.pathname === next.pathname &&
    cachedSnapshot.search === next.search
  ) {
    return cachedSnapshot;
  }
  cachedSnapshot = next;
  return next;
}

function readServerSnapshot(): ShellLocationSnapshot {
  return SERVER_SNAPSHOT;
}

function emitShellLocationChange(): void {
  const popStateEvent =
    typeof PopStateEvent === 'function'
      ? new PopStateEvent('popstate', { state: window.history.state })
      : new Event('popstate');
  window.dispatchEvent(popStateEvent);
  window.dispatchEvent(new Event(SHELL_LOCATION_EVENT));
}

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener('popstate', onStoreChange);
  window.addEventListener(SHELL_LOCATION_EVENT, onStoreChange);
  return () => {
    window.removeEventListener('popstate', onStoreChange);
    window.removeEventListener(SHELL_LOCATION_EVENT, onStoreChange);
  };
}

export function toShellUrl(url: string): string {
  if (typeof window === 'undefined') return url;
  const next = new URL(url, window.location.href);
  if (next.origin !== window.location.origin) return url;
  return `${next.pathname}${next.search}${next.hash}`;
}

export function navigateShellUrl(url: string, mode: ShellNavigateMode = 'push'): void {
  if (typeof window === 'undefined') return;
  const nextUrl = toShellUrl(url);
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl === currentUrl) return;
  const method = mode === 'replace' ? 'replaceState' : 'pushState';
  window.history[method](window.history.state, '', nextUrl);
  emitShellLocationChange();
}

export function pushShellUrl(url: string): void {
  navigateShellUrl(url, 'push');
}

export function replaceShellUrl(url: string): void {
  navigateShellUrl(url, 'replace');
}

export function useShellPathname(): string {
  return useSyncExternalStore(
    subscribe,
    () => readSnapshot().pathname,
    () => readServerSnapshot().pathname
  );
}

export function useShellSearchParam(param: string): string | null {
  const getSnapshot = useCallback(() => new URLSearchParams(readSnapshot().search).get(param), [param]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
