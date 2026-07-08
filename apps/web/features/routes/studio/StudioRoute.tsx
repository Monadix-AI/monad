'use client';

import dynamic from 'next/dynamic';

import { StudioRouteLoading } from '#/features/studio/StudioLoading';

const Studio = dynamic(() => import('#/features/studio/Studio').then((m) => m.Studio), {
  loading: StudioRouteLoading,
  ssr: false
});

export function StudioRoute({ onClose }: { onClose: () => void }) {
  return <Studio onClose={onClose} />;
}
