import type { FilesystemObservationPolicy } from './exec/protocol.ts';
import type { VmMountPlan } from './mount-plan.ts';

import { posix } from 'node:path';

function normalizedRoots(paths: string[]): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    const normalized = posix.normalize(path);
    if (!posix.isAbsolute(normalized)) throw new Error(`observation policy path must be absolute: ${path}`);
    roots.add(normalized);
  }
  return [...roots].sort((a, b) => {
    const depth = (value: string) => value.split('/').filter(Boolean).length;
    return depth(a) - depth(b) || a.localeCompare(b);
  });
}

export function observationPolicyFor(plan: VmMountPlan): FilesystemObservationPolicy {
  return {
    writableRoots: normalizedRoots(plan.shares.filter((share) => !share.readOnly).map((share) => share.guestPath)),
    noWriteRoots: normalizedRoots([
      ...plan.shares.filter((share) => share.readOnly).map((share) => share.guestPath),
      ...plan.overlays.map((overlay) => overlay.target)
    ])
  };
}
