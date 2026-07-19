import type { SessionId } from '@monad/protocol';
import type { ExternalAgentStreamView, Participant } from '../../../experience/types.ts';
import type { ObservationPanelHooks } from './use-observation-panel.ts';

import { useEffect } from 'react';

import { ObservationModeToggle } from './observation-mode-toggle.tsx';
import { convenienceStreamView } from './observation-panel-orchestration.ts';
import { ExternalAgentObservationPanel } from './panel.tsx';
import { RawObservationList } from './raw-observation-list.tsx';
import { useObservationPanel } from './use-observation-panel.ts';

export interface DualObservationPanelProps {
  externalAgentSessionId: string;
  transcriptTargetId: SessionId;
  agentName: string;
  provider: string;
  agent?: Participant;
  icon?: ExternalAgentStreamView['icon'];
  hooks: ObservationPanelHooks;
  connectionSignal?: string;
  onBack?: () => void;
}

// The connection-lifecycle-driven observation panel (raw ⇆ convenience). Convenience events render
// through the shared ExternalAgentObservationPanel; raw frames render verbatim. Opening/closing here
// only holds/disposes the scoped SSE — it never touches the provider runtime.
export function DualObservationPanel(props: DualObservationPanelProps): React.ReactElement {
  const {
    externalAgentSessionId,
    transcriptTargetId,
    agentName,
    provider,
    agent,
    icon,
    hooks,
    connectionSignal,
    onBack
  } = props;
  const controller = useObservationPanel({
    externalAgentSessionId,
    transcriptTargetId,
    agentName,
    provider,
    ...(icon ? { icon } : {}),
    hooks,
    ...(connectionSignal ? { connectionSignal } : {})
  });
  const { open, close } = controller;

  useEffect(() => {
    open();
    return close;
  }, [open, close]);

  const stream = convenienceStreamView(
    { id: externalAgentSessionId, transcriptTargetId, agentName, provider, ...(icon ? { icon } : {}) },
    controller.events,
    controller.connected
  );

  return (
    <ExternalAgentObservationPanel
      agent={agent}
      agentName={agentName}
      content={controller.mode === 'raw' ? <RawObservationList rows={controller.rawRows} /> : undefined}
      headerActions={
        <ObservationModeToggle
          mode={controller.mode}
          onSelect={controller.setMode}
        />
      }
      icon={icon}
      observationLoading={controller.loading}
      observationUnavailable={Boolean(controller.unavailableReason)}
      onBack={onBack}
      showObservationControls={controller.mode === 'convenience'}
      stream={stream}
    />
  );
}
