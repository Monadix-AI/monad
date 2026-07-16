// Channel registry assembly: load built-in channel adapters and discover third-party channel atom
// packs, then merge into one registry. Generic over the per-call sinks (which wire providers/
// commands into the daemon's registries) so both the boot build and the post-install reload share it.

import type { MonadPaths } from '@monad/environment';

import { logger } from '@monad/logger';

import { discoverChannelAdapters } from '#/channels/discover.ts';
import { builtinChannelAdapters, mergeRegistries } from '#/channels/registry.ts';

export type BuiltinSinks = Parameters<typeof builtinChannelAdapters>[1];
export type DiscoveredSinks = Parameters<typeof discoverChannelAdapters>[1];

export async function createChannelRegistry(
  paths: MonadPaths,
  opts: { builtin?: BuiltinSinks; discovered?: DiscoveredSinks } = {}
): Promise<ReturnType<typeof mergeRegistries>> {
  // Load the built-in pack FIRST, capturing the provider types it registers — they become the
  // reserved set for the discovered pass (a third-party `provider` atom may not shadow a built-in
  // type). This is the single source of "which providers are first-party": whatever the built-in
  // atom pack actually registered, not a separately-imported list that could drift from it.
  const reservedProviderTypes = new Set<string>();
  const builtinOnProvider = opts.builtin?.onProvider;
  const builtinSinks: BuiltinSinks | undefined = opts.builtin && {
    ...opts.builtin,
    onProvider: (p) => {
      reservedProviderTypes.add(p.type);
      builtinOnProvider?.(p);
    }
  };
  const builtin = await builtinChannelAdapters(
    (atomPack, error) => logger.warn(`monad: builtin channel atom pack "${atomPack}" failed to load: ${error}`),
    builtinSinks
  );
  const discovered = await discoverChannelAdapters(
    paths.packs,
    opts.discovered && { ...opts.discovered, reservedProviderTypes }
  );
  for (const e of discovered.errors) logger.warn(`monad: channel atom pack "${e.atom}" failed to load: ${e.error}`);
  return mergeRegistries(builtin, discovered.factories);
}
