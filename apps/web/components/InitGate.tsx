'use client';

import type { ReactNode } from 'react';

import { useInitStatusQuery } from '@monad/client-rtk';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { MonadLoading } from '@/components/MonadLoading';

export function InitGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data, isLoading } = useInitStatusQuery();
  const initialized = data?.initialized ?? false;

  // Uninitialized → send the user to the dedicated /init wizard route.
  useEffect(() => {
    if (!isLoading && !initialized) router.replace('/init');
  }, [isLoading, initialized, router]);

  if (isLoading || !initialized) {
    return <MonadLoading className="h-screen" />;
  }

  return <>{children}</>;
}
