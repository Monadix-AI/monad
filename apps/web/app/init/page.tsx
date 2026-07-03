'use client';

import { useInitStatusQuery } from '@monad/client-rtk';

import { InitBackground } from '@/features/init/InitBackground';
import { InitWizard } from '@/features/init/InitWizard';
import { MonadLoading } from '@/features/init/MonadLoading';

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
