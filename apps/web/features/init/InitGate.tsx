'use client';

import type { ReactNode } from 'react';

import { useInitStatusQuery } from '@monad/client-rtk';

import { MonadLoading } from './MonadLoading';

export function InitGate({ children }: { children: ReactNode }) {
  const { isLoading } = useInitStatusQuery();

  if (isLoading) {
    return <MonadLoading className="h-screen" />;
  }

  return <>{children}</>;
}
