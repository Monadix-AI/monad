'use client';

import { useInitStatusQuery } from '@monad/client-rtk';

import { MonadLoading } from '#/components/MonadLoading';
import { InitBackground } from '#/features/init/InitBackground';
import { InitWizard } from '#/features/init/InitWizard';

export function InitRoute() {
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
