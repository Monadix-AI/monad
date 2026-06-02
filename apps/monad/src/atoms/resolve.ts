// Bare-name resolution for namespace-coexist atom kinds (tool/connector/channel/command/...).
//
// Every atom is also addressable by its fully-qualified `<packId>__<id>` name, so nothing is lost
// when two packs claim the same bare id. The BARE id resolves to one winner: the user's pin if the
// pinned pack actually provides it, otherwise first-wins by load order (the caller passes candidates
// in sorted-pack order, so this is deterministic). Pure + format-agnostic: the per-kind registry
// decides how to spell the qualified name and what to do with shadowed entries.

export interface AtomCandidate {
  /** The bare id two packs might collide on (tool/connector name, channel type, command name, …). */
  bareId: string;
  /** The owning atom pack's identity (folder name). */
  packId: string;
}

// AtomConflict crosses the HTTP boundary (listAtomPacks), so its schema is the protocol's.
export type { AtomConflict } from '@monad/protocol';

export interface AtomResolution {
  /** bareId → winning packId. */
  winners: Map<string, string>;
  /** Per colliding bareId: who won and which packs were shadowed (for UI surfacing + logs). */
  collisions: Array<{ bareId: string; winner: string; shadowed: string[] }>;
}

/** The fully-qualified, always-addressable name for an atom (the escape hatch). */
export function qualifiedAtomName(packId: string, bareId: string, sep = '__'): string {
  return `${packId}${sep}${bareId}`;
}

/**
 * Resolve bare-id winners. `candidates` MUST be in load order (sorted pack folder) so first-wins is
 * deterministic. `pins` maps bareId → packId; a pin only takes effect if that pack actually provides
 * the id (otherwise it falls back to first-wins, e.g. the pinned pack was removed).
 */
export function resolveAtomPins(
  candidates: readonly AtomCandidate[],
  pins: Readonly<Record<string, string>> = {}
): AtomResolution {
  const byId = new Map<string, string[]>(); // bareId → packIds in load order
  for (const c of candidates) {
    const list = byId.get(c.bareId);
    if (list) list.push(c.packId);
    else byId.set(c.bareId, [c.packId]);
  }

  const winners = new Map<string, string>();
  const collisions: AtomResolution['collisions'] = [];
  for (const [bareId, packs] of byId) {
    const pinned = pins[bareId];
    const winner = pinned && packs.includes(pinned) ? pinned : (packs[0] as string);
    winners.set(bareId, winner);
    if (packs.length > 1) {
      collisions.push({ bareId, winner, shadowed: packs.filter((p) => p !== winner) });
    }
  }
  return { winners, collisions };
}
