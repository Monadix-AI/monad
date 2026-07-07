// The external agent-adapter contract now lives in @monad/sdk-atom (the atom authoring layer), so
// the adapter atoms in @monad/atoms and the daemon host share one definition. This barrel keeps the
// daemon's existing `@/services/external-agent/types.ts` imports resolving.
export type {
  BuildExternalAgentLaunchOptions,
  ExternalAgentAppServerConnection,
  ExternalAgentArgumentSupport,
  ExternalAgentArgumentSupportProbe,
  ExternalAgentInitializeContext,
  ExternalAgentLaunchSpec,
  ExternalAgentOutputEvent,
  ExternalAgentProviderAdapter,
  ExternalAgentRuntimeHandle,
  ExternalAgentStartPreflight
} from '@monad/sdk-atom';

export { externalAgentOutputEventSchema } from '@monad/sdk-atom';
