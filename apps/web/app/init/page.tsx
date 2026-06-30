'use client';

import { useInitStatusQuery } from '@monad/client-rtk';

import { InitBackground } from '@/components/InitBackground';
import { InitWizard } from '@/components/InitWizard';
import { MonadLoading } from '@/components/MonadLoading';

export default function InitPage() {
  const { data, isLoading } = useInitStatusQuery();

  if (isLoading) {
    return (
      <>
        <InitBackground />
        <MonadLoading className="h-screen text-white" />
      </>
    );
  }

  return <InitWizard homePath={data?.homePath} />;
}
