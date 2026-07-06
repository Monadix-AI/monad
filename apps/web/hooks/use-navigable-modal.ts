'use client';

import { useCallback } from 'react';

import { pushShellUrl, replaceShellUrl, useShellPathname, useShellSearchParam } from './use-shell-location';

export function buildNavigableModalUrl(pathname: string, search: string, param: string, next: string | null): string {
  const params = new URLSearchParams(search);
  if (next === null) {
    params.delete(param);
  } else {
    params.set(param, next);
  }
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * Sync a modal/panel open-state with a URL search param so that:
 *   - back button closes the modal (opening pushes a history entry)
 *   - changing the value inside the modal replaces in place (no history noise)
 *   - closing replaces in place (no history entry for "closed" state)
 *
 * Returns [currentValue | null, setter].
 *   setter(null)    → close  (history.replaceState, remove param)
 *   setter('x')     → open   (history.pushState if currently closed)
 *   setter('y')     → change (history.replaceState if already open)
 */
export function useNavigableModal(param: string): [string | null, (value: string | null) => void] {
  const pathname = useShellPathname();
  const current = useShellSearchParam(param);

  const set = useCallback(
    (next: string | null) => {
      const search = typeof window === 'undefined' ? '' : window.location.search;
      const url = buildNavigableModalUrl(pathname, search, param, next);
      if (next !== null && current === null) {
        pushShellUrl(url);
      } else {
        replaceShellUrl(url);
      }
    },
    [pathname, param, current]
  );

  return [current, set];
}
