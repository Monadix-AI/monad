import type { AnyRouter } from '@tanstack/react-router';

import { useRouterState } from '@tanstack/react-router';

export type ShellNavigateMode = 'push' | 'replace';

// The app entry registers the TanStack router here once, so imperative navigation
// (shell handlers, experience adapters, ShellLink) drives the router directly — a single
// routing source instead of hand-rolled history.pushState + synthetic popstate events.
let shellRouter: AnyRouter | null = null;

export function setShellRouter(router: AnyRouter | null): void {
  shellRouter = router;
}

export function toShellUrl(url: string): string {
  if (typeof window === 'undefined') return url;
  const next = new URL(url, window.location.href);
  if (next.origin !== window.location.origin) return url;
  return `${next.pathname}${next.search}${next.hash}`;
}

function currentShellUrl(): string {
  const location = shellRouter?.state.location;
  if (location) return location.href;
  return browserShellUrl();
}

function browserShellUrl(): string {
  if (typeof window === 'undefined') return '/';
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function navigateShellUrl(url: string, mode: ShellNavigateMode = 'push'): void {
  const nextUrl = toShellUrl(url);
  if (nextUrl === currentShellUrl()) return;
  if (shellRouter) {
    if (mode === 'replace') shellRouter.history.replace(nextUrl);
    else shellRouter.history.push(nextUrl);
    if (typeof window === 'undefined' || nextUrl === browserShellUrl()) return;
  }
  if (typeof window === 'undefined') return;
  if (mode === 'replace') window.history.replaceState(window.history.state, '', nextUrl);
  else window.history.pushState(window.history.state, '', nextUrl);
  window.dispatchEvent(typeof PopStateEvent === 'undefined' ? new Event('popstate') : new PopStateEvent('popstate'));
}

export function pushShellUrl(url: string): void {
  navigateShellUrl(url, 'push');
}

export function replaceShellUrl(url: string): void {
  navigateShellUrl(url, 'replace');
}

export function removeShellSearchParam(param: string, expectedValue?: string): void {
  const current = new URL(currentShellUrl(), 'http://monad.local');
  if (!current.searchParams.has(param)) return;
  if (expectedValue !== undefined && current.searchParams.get(param) !== expectedValue) return;
  current.searchParams.delete(param);
  replaceShellUrl(`${current.pathname}${current.search}${current.hash}`);
}

export function useShellPathname(): string {
  return useRouterState({ select: (state) => state.location.pathname });
}

export function useShellSearchParam(param: string): string | null {
  return useRouterState({
    select: (state) => new URLSearchParams(state.location.searchStr).get(param)
  });
}
