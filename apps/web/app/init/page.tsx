'use client';

import { useInitStatusQuery } from '@monad/client-rtk';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { InitBackground } from '@/components/InitBackground';
import { InitWizard } from '@/components/InitWizard';
import { MonadLoading } from '@/components/MonadLoading';
import { shouldRedirectInitToHome } from '@/lib/init-redirect';

export default function InitPage() {
  const router = useRouter();
  const { data, isLoading } = useInitStatusQuery();
  const initialized = data?.initialized ?? false;
  // Release builds leave the wizard once initialized; dev builds keep /init open.
  const leaving = shouldRedirectInitToHome(initialized);

  useEffect(() => {
    if (!isLoading && leaving) router.replace('/');
  }, [isLoading, leaving, router]);

  if (isLoading || leaving) {
    return (
      <>
        <InitBackground />
        <MonadLoading className="h-screen text-white" />
      </>
    );
  }

  return <InitWizard homePath={data?.homePath} />;
}
