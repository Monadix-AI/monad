'use client';

import dynamic from 'next/dynamic';

import { PanelLoading } from '@/components/PanelLoading';

const Studio = dynamic(() => import('@/features/studio/Studio').then((m) => m.Studio), {
  loading: PanelLoading,
  ssr: false
});

export function StudioRoute({ onClose }: { onClose: () => void }) {
  return <Studio onClose={onClose} />;
}
