import { createFileRoute } from '@tanstack/react-router';

import { useT } from '#/components/I18nProvider';
import { lazyComponent } from '#/lib/lazy-component';

const LiveEventReplay = lazyComponent(
  () => import('#/features/developer/LiveEventReplay').then((module) => module.LiveEventReplay),
  ReplayLoading
);

export const Route = createFileRoute('/developer/live-event-replay')({
  component: LiveEventReplayRoute
});

function LiveEventReplayRoute() {
  return <LiveEventReplay />;
}

function ReplayLoading() {
  const t = useT();
  return (
    <div className="flex h-screen items-center justify-center text-muted-foreground text-sm">
      {t('web.developerReplay.loading')}
    </div>
  );
}
