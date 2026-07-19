import type { MeshAgentProvider } from '@monad/protocol';

import { builtinMeshAgentObservationAdapters } from './agent-adapters/observation-adapters.ts';
import { configureMeshAgentObservationAdapterResolver } from './workspace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';

// Composition module: it wires the experience's observation-adapter resolver (an injection slot the
// experience OWNS) to the builtin adapter parsers. It is neither the experience nor an agent adapter,
// so it doesn't couple those layers — a composition root (the atoms barrel for the daemon, the web/TUI
// app for the browser) imports THIS. Browser-safe: the adapter list is pure parsers only.
let configured = false;

/** Point the client-side MeshAgent observation parser at the builtin provider adapters. Without this
 *  a browser host renders structured provider output as raw JSON (the resolver stays unset). Idempotent
 *  so multiple composition roots can call it safely. */
export function configureBuiltinMeshAgentObservationAdapters(): void {
  if (configured) return;
  configured = true;
  const byProvider = new Map(builtinMeshAgentObservationAdapters.map((entry) => [entry.provider, entry]));
  configureMeshAgentObservationAdapterResolver((provider: MeshAgentProvider | string | undefined) =>
    provider === undefined ? undefined : byProvider.get(provider)
  );
}
