import type { AgentObservationEvent, MeshConvenienceFrame, SessionId } from '@monad/protocol';
import type { MeshAgentStreamView, Participant } from '../../experience/types.ts';
import type { ObservationPanelHooks } from './observation/use-observation-panel.ts';

import { useEffect, useRef, useState } from 'react';

import { emptyObservationTimeline, mergeConvenienceFrame } from './observation/timeline-merge.ts';

const EMPTY_OBSERVATION_EVENTS: readonly AgentObservationEvent[] = [];
const EMPTY_CONVENIENCE_FRAMES: MeshConvenienceFrame[] = [];

function useRailAgentObservationEvents(
  stream: MeshAgentStreamView | undefined,
  hooks: ObservationPanelHooks
): readonly AgentObservationEvent[] | undefined {
  const transcriptTargetId = stream?.transcriptTargetId;
  const active = Boolean(stream?.id && transcriptTargetId);
  const result = hooks.useConvenienceStream(
    {
      id: stream?.id ?? '',
      transcriptTargetId: (transcriptTargetId ?? 'ses_') as SessionId
    },
    { skip: !active }
  );
  const [timeline, setTimeline] = useState(emptyObservationTimeline);
  const consumedFrameCountRef = useRef(0);
  const frames = result.currentData?.frames ?? EMPTY_CONVENIENCE_FRAMES;
  const frameOffset = result.currentData?.frameOffset ?? 0;
  const scopeKey = active ? `${stream?.id}:${transcriptTargetId}` : '';

  useEffect(() => {
    void scopeKey;
    consumedFrameCountRef.current = 0;
    setTimeline(emptyObservationTimeline);
  }, [scopeKey]);

  useEffect(() => {
    const availableEnd = frameOffset + frames.length;
    if (availableEnd < consumedFrameCountRef.current) consumedFrameCountRef.current = 0;
    if (!active || availableEnd <= consumedFrameCountRef.current) return;
    const sliceStart = Math.max(consumedFrameCountRef.current, frameOffset) - frameOffset;
    const nextFrames = frames.slice(sliceStart);
    consumedFrameCountRef.current = availableEnd;
    setTimeline((current) => nextFrames.reduce(mergeConvenienceFrame, current));
  }, [active, frameOffset, frames]);

  if (!active || result.currentData?.fatalError) return EMPTY_OBSERVATION_EVENTS;
  return timeline.epoch === null ? undefined : timeline.events;
}

export function RailAgentActivity({
  agent,
  hooks,
  render,
  stream
}: {
  agent: Participant;
  hooks: ObservationPanelHooks;
  render: (agent: Participant, observationEvents?: readonly AgentObservationEvent[]) => React.ReactElement;
  stream: MeshAgentStreamView | undefined;
}): React.ReactElement {
  return render(agent, useRailAgentObservationEvents(stream, hooks));
}
