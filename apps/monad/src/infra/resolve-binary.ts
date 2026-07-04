// Moved to @monad/sdk-atom so the agent-adapter atoms and the daemon share one binary resolver.
// Re-exported here so existing daemon imports (obscura, delegation presets, native-cli host) keep
// resolving.

export type { BinProbes } from '@monad/sdk-atom';

export { defaultBinProbes, resolveBinary } from '@monad/sdk-atom';
