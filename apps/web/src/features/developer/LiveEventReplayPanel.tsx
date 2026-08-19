import type { agentObservationCards } from '@monad/atoms/live-event-replay';
import type { ReplaySource } from './live-event-replay-model';

import { MeshAgentObservationPanel } from '@monad/atoms/live-event-replay';
import { Fragment, type ReactNode } from 'react';

export function LiveEventReplayPanelBoundary({
  children,
  meshSessionId,
  source
}: {
  children: ReactNode;
  meshSessionId: string;
  source: ReplaySource;
}): React.ReactElement {
  return <Fragment key={`${meshSessionId}:${source}`}>{children}</Fragment>;
}

export function LiveEventReplayPanel({
  agentName,
  cards,
  meshSessionId,
  provider,
  source
}: {
  agentName: string;
  cards: ReturnType<typeof agentObservationCards>;
  meshSessionId: string;
  provider: string;
  source: ReplaySource;
}): React.ReactElement {
  return (
    <LiveEventReplayPanelBoundary
      meshSessionId={meshSessionId}
      source={source}
    >
      <MeshAgentObservationPanel
        agentName={agentName}
        eventsActive
        stream={{
          id: `${meshSessionId}:${source}:replay`,
          agentName,
          provider,
          tag: source,
          status: 'running',
          output: '',
          items: cards
        }}
      />
    </LiveEventReplayPanelBoundary>
  );
}
