// The native-CLI agent-adapter contract now lives in @monad/sdk-atom (the atom authoring layer), so
// the adapter atoms in @monad/atoms and the daemon host share one definition. This barrel keeps the
// daemon's existing `@/services/native-cli/types.ts` imports resolving.
export type {
  BuildNativeCliLaunchOptions,
  NativeCliAppServerConnection,
  NativeCliArgumentSupport,
  NativeCliArgumentSupportProbe,
  NativeCliInitializeContext,
  NativeCliLaunchSpec,
  NativeCliOutputEvent,
  NativeCliProviderAdapter,
  NativeCliRuntimeHandle,
  NativeCliStartPreflight
} from '@monad/sdk-atom';

export { nativeCliOutputEventSchema } from '@monad/sdk-atom';
