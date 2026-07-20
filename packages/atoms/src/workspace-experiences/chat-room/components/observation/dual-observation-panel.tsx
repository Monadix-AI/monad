import type { SessionId } from '@monad/protocol';
import type { MeshAgentStreamView, Participant } from '../../../experience/types.ts';
import type { RawDisplayMode } from './raw-view.ts';
import type { ObservationPanelHooks } from './use-observation-panel.ts';

import { useEffect, useRef, useState } from 'react';

import { ObservationModeToggle, RawDisplayModeToggle } from './observation-mode-toggle.tsx';
import { convenienceStreamView } from './observation-panel-orchestration.ts';
import { MeshAgentObservationPanel } from './panel.tsx';
import { RawObservationList, type RawObservationListHandle } from './raw-observation-list.tsx';
import { useObservationPanel } from './use-observation-panel.ts';

export interface DualObservationPanelProps {
  meshSessionId: string;
  transcriptTargetId: SessionId;
  agentName: string;
  provider: string;
  agent?: Participant;
  icon?: MeshAgentStreamView['icon'];
  hooks: ObservationPanelHooks;
  connectionSignal?: string;
  onBack?: () => void;
}

// The connection-lifecycle-driven observation panel (raw ⇆ convenience). Convenience events render
// through the shared MeshAgentObservationPanel; raw frames render verbatim. Opening/closing here
// only holds/disposes the scoped SSE — it never touches the provider runtime.
export function DualObservationPanel(props: DualObservationPanelProps): React.ReactElement {
  const { meshSessionId, transcriptTargetId, agentName, provider, agent, icon, hooks, connectionSignal, onBack } =
    props;
  const controller = useObservationPanel({
    meshSessionId,
    transcriptTargetId,
    agentName,
    provider,
    ...(icon ? { icon } : {}),
    hooks,
    ...(connectionSignal ? { connectionSignal } : {})
  });
  const { open, close } = controller;
  const [rawDisplayMode, setRawDisplayMode] = useState<RawDisplayMode>('lines');
  const rawListRef = useRef<RawObservationListHandle>(null);

  useEffect(() => {
    open();
    return close;
  }, [open, close]);

  const stream = convenienceStreamView(
    { id: meshSessionId, transcriptTargetId, agentName, provider, ...(icon ? { icon } : {}) },
    controller.events,
    controller.connected
  );

  return (
    <MeshAgentObservationPanel
      agent={agent}
      agentName={agentName}
      canLoadOlderEvents={controller.canLoadOlderEvents}
      content={
        controller.mode === 'raw' ? (
          <RawObservationList
            canLoadOlderEvents={controller.canLoadOlderEvents}
            controlRef={rawListRef}
            displayMode={rawDisplayMode}
            key={meshSessionId}
            loadingOlderEvents={controller.loadingOlderEvents}
            onLoadOlderEvents={controller.loadOlderEvents}
            rows={controller.rawRows}
          />
        ) : undefined
      }
      contentControlRef={rawListRef}
      contentHasItems={controller.rawRows.length > 0}
      eventsActive
      headerActions={
        <div style={{ alignItems: 'center', display: 'inline-flex', gap: 8 }}>
          {controller.mode === 'raw' ? (
            <RawDisplayModeToggle
              mode={rawDisplayMode}
              onSelect={setRawDisplayMode}
            />
          ) : null}
          <ObservationModeToggle
            mode={controller.mode}
            onSelect={controller.setMode}
          />
        </div>
      }
      icon={icon}
      key={meshSessionId}
      loadingOlderEvents={controller.loadingOlderEvents}
      observationLoading={controller.loading}
      observationUnavailable={Boolean(controller.unavailableReason)}
      onBack={onBack}
      onLoadOlderEvents={controller.loadOlderEvents}
      onRetryOlderEvents={controller.retryOlderEvents}
      showObservationControls={controller.mode === 'convenience'}
      stream={stream}
    />
  );
}
