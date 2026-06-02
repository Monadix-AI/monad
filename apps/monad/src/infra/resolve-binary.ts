import { existsSync } from 'node:fs';

// Locate an executable: prefer one on PATH, else the first existing candidate absolute path (e.g. an
// app-bundle location that isn't symlinked onto PATH). Shared by same-machine detection across the
// daemon (acp-agent presets, obscura) so the PATH-then-candidates rule — and any future Windows
// .exe/.cmd handling — lives in one place. Probes are injectable for deterministic tests.

export interface BinProbes {
  which: (name: string) => string | undefined;
  exists: (path: string) => boolean;
}

export const defaultBinProbes: BinProbes = {
  which: (name) => Bun.which(name) ?? undefined,
  exists: existsSync
};

/** PATH lookup, then the first existing candidate path; undefined if none resolve. */
export function resolveBinary(
  name: string,
  candidates: string[],
  probes: BinProbes = defaultBinProbes
): string | undefined {
  return probes.which(name) ?? candidates.find((p) => probes.exists(p));
}
