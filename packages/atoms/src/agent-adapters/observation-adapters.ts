import type { ExternalAgentProviderAdapter } from '@monad/sdk-atom';

import { claudeCodeObservationProjection } from './claude-code/observation.ts';
import { codexObservationProjection } from './codex/observation/index.ts';
import { geminiObservationProjection } from './gemini/observation.ts';
import { hermesObservationProjection } from './hermes/observation.ts';
import { openClawObservationProjection } from './openclaw/observation.ts';
import { qwenObservationProjection } from './qwen/observation.ts';

export type ExternalAgentObservationAdapterEntry = Pick<ExternalAgentProviderAdapter, 'observation' | 'provider'>;

// Observation projections only — pure parsers with no launcher/spawn/node dependency, so this list is
// safe to load in the browser bundle (the full `builtinAgentAdapters` pulls node-only runtime). This
// module knows nothing about the experience layer; the composition root wires it into the resolver.
export const builtinExternalAgentObservationAdapters: ExternalAgentObservationAdapterEntry[] = [
  { provider: 'claude-code', observation: claudeCodeObservationProjection },
  { provider: 'codex', observation: codexObservationProjection },
  { provider: 'gemini', observation: geminiObservationProjection },
  { provider: 'qwen', observation: qwenObservationProjection },
  { provider: 'hermes', observation: hermesObservationProjection },
  { provider: 'openclaw', observation: openClawObservationProjection }
];
