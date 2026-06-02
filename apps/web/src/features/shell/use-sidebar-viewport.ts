import { useEffect, useState } from 'react';

const NARROW_SIDEBAR_QUERY = '(max-width: 47.999rem)';

function readIsNarrowSidebarViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(NARROW_SIDEBAR_QUERY).matches;
}

export function useIsNarrowSidebarViewport(): boolean {
  const [narrow, setNarrow] = useState(readIsNarrowSidebarViewport);

  useEffect(() => {
    const media = window.matchMedia(NARROW_SIDEBAR_QUERY);
    const sync = () => setNarrow(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  return narrow;
}
