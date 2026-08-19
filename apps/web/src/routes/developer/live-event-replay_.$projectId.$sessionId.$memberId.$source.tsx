import type { LiveEventReplayProps } from '#/features/developer/LiveEventReplay';

import { createFileRoute, Navigate } from '@tanstack/react-router';

import { useT } from '#/components/I18nProvider';
import { replaySource } from '#/features/developer/live-event-replay-model';
import { lazyComponent } from '#/lib/lazy-component';

const LiveEventReplay = lazyComponent<LiveEventReplayProps>(
  () => import('#/features/developer/LiveEventReplay').then((module) => module.LiveEventReplay),
  ReplayLoading
);

export const Route = createFileRoute('/developer/live-event-replay_/$projectId/$sessionId/$memberId/$source')({
  component: LiveEventReplaySelectionRoute
});

function LiveEventReplaySelectionRoute() {
  const { projectId, sessionId, memberId, source: sourceParam } = Route.useParams();
  const source = replaySource(sourceParam);
  if (!source)
    return (
      <Navigate
        replace
        to="/developer/live-event-replay"
      />
    );
  return <LiveEventReplay initialSelection={{ projectId, sessionId, memberId, source }} />;
}

function ReplayLoading() {
  const t = useT();
  return (
    <div className="flex h-screen items-center justify-center text-muted-foreground text-sm">
      {t('web.developerReplay.loading')}
    </div>
  );
}
