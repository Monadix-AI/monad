import type { ManifestAtomPack } from '@monad/sdk-atom';

import { logger } from '@monad/logger';

// A pack object is the module's default export, so Bun's ESM cache hands back the same instance on
// every sweep. Keying by identity rather than by pack id means a reinstall that re-imports the same
// module is not mistaken for an already-deactivated pack, and a pack dropped twice is torn down
// once. WeakSet so an unloaded pack is still collectable.
const deactivated = new WeakSet<ManifestAtomPack>();

/**
 * Tear down a pack the host has stopped loading. Registrations are already gone by this point — this
 * is for whatever `register()` acquired that the host cannot reclaim: timers, sockets, watchers.
 *
 * Never throws: a pack that fails to clean up is logged and the sweep continues, because the
 * alternative is a reload that aborts on a third party's teardown bug.
 */
export async function deactivateAtomPack(atomPackId: string, atomPack: ManifestAtomPack): Promise<void> {
  if (!atomPack.deactivate || deactivated.has(atomPack)) return;
  deactivated.add(atomPack);
  try {
    await atomPack.deactivate();
  } catch (err) {
    logger.warn(`monad: Atom Pack "${atomPackId}" failed to deactivate: ${err instanceof Error ? err.message : err}`);
  }
}
