'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

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
 *   setter(null)    → close  (router.replace, remove param)
 *   setter('x')     → open   (router.push   if currently closed)
 *   setter('y')     → change (router.replace if already open)
 */
export function useNavigableModal(param: string): [string | null, (value: string | null) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get(param);

  const set = useCallback(
    (next: string | null) => {
      const url = buildNavigableModalUrl(pathname, searchParams.toString(), param, next);
      if (next !== null && current === null) {
        router.push(url);
      } else {
        router.replace(url);
      }
    },
    [router, pathname, searchParams, param, current]
  );

  return [current, set];
}
