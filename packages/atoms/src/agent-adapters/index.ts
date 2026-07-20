import type { MeshAgentProviderAdapter } from '@monad/sdk-atom';

import {
  meshAgentEventsAreGenerating,
  meshAgentStructuredEvents
} from '../workspace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';
import { claudeCodeMeshAgentAdapter } from './claude-code/index.ts';
import { codexMeshAgentAdapter } from './codex/index.ts';
import { geminiMeshAgentAdapter } from './gemini/index.ts';
import { hermesMeshAgentAdapter } from './hermes/index.ts';
import { toAgentObservationEvent } from './neutral-observation.ts';
import { openClawMeshAgentAdapter } from './openclaw/index.ts';
import { qwenMeshAgentAdapter } from './qwen/index.ts';

export { claudeCodeMeshAgentAdapter, createClaudeSdkEventPageReader } from './claude-code/index.ts';

/** The built-in native coding-CLI agent adapters, registered as `agent-adapter` atoms. */
const adapters: MeshAgentProviderAdapter[] = [
  codexMeshAgentAdapter,
  claudeCodeMeshAgentAdapter,
  geminiMeshAgentAdapter,
  qwenMeshAgentAdapter,
  openClawMeshAgentAdapter,
  hermesMeshAgentAdapter
];

for (const adapter of adapters) {
  adapter.observationRuntime = {
    toAgentObservationEvent: (event) => toAgentObservationEvent(event, adapter.observation),
    structuredEvents: (args) => meshAgentStructuredEvents({ ...args, provider: adapter.provider, adapter }),
    eventsAreGenerating: (events) => meshAgentEventsAreGenerating(events, { provider: adapter.provider, adapter })
  };
}

export const builtinAgentAdapters = adapters;
