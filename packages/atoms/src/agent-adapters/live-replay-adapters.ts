import type { MeshAgentProvider } from '@monad/protocol';
import type { LiveProjectionAdapter, MeshAgentObservationProjector } from '@monad/sdk-atom';

import { antigravityObservationProjection } from './antigravity/observation.ts';
import { claudeCodeObservationProjection } from './claude-code/observation.ts';
import { codexObservationProjection } from './codex/observation/index.ts';
import { geminiObservationProjection } from './gemini/observation.ts';
import { hermesObservationProjection } from './hermes/observation.ts';
import { monadObservationProjection } from './monad/observation.ts';
import { openClawObservationProjection } from './openclaw/observation.ts';
import { qwenObservationProjection } from './qwen/observation.ts';
import { createProjectedEventSource } from './shared/events/event-source.ts';
import { toAgentObservationEvent } from './shared/observation/neutral-observation.ts';

export type LiveReplayAdapter = LiveProjectionAdapter & { provider: MeshAgentProvider };

function liveReplayAdapter(provider: MeshAgentProvider, observation: MeshAgentObservationProjector): LiveReplayAdapter {
  return {
    provider,
    observation,
    events: createProjectedEventSource({ provider, projection: observation }),
    observationRuntime: {
      toAgentObservationEvent: (event) => toAgentObservationEvent(event, observation)
    }
  };
}

export const builtinLiveReplayAdapters: LiveReplayAdapter[] = [
  liveReplayAdapter('antigravity', antigravityObservationProjection),
  liveReplayAdapter('claude-code', claudeCodeObservationProjection),
  liveReplayAdapter('codex', codexObservationProjection),
  liveReplayAdapter('gemini', geminiObservationProjection),
  liveReplayAdapter('hermes', hermesObservationProjection),
  liveReplayAdapter('monad', monadObservationProjection),
  liveReplayAdapter('openclaw', openClawObservationProjection),
  liveReplayAdapter('qwen', qwenObservationProjection)
];
