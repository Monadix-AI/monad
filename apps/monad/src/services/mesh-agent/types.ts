// The MeshAgent-adapter contract now lives in @monad/sdk-atom (the atom authoring layer), so
// the adapter atoms in @monad/atoms and the daemon host share one definition. This barrel keeps the
// daemon's existing `@/services/mesh-agent/types.ts` imports resolving.
export type {
  MeshAgentArgumentSupport,
  MeshAgentLaunchSpec,
  MeshAgentModelOption,
  MeshAgentOutputEvent,
  MeshAgentProviderAdapter,
  MeshAgentStartPreflight
} from '@monad/sdk-atom';
