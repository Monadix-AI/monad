'use client';

import dynamic from 'next/dynamic';

const Studio = dynamic(() => import('@/components/studio/Studio').then((m) => m.Studio), { ssr: false });

export function StudioRoute({ onClose }: { onClose: () => void }) {
  return <Studio onClose={onClose} />;
}
