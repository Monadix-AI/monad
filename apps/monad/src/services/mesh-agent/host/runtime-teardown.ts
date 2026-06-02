import type { LiveMeshSession } from '#/services/mesh-agent/host/host-types.ts';
export function disposeLiveCapture(live: LiveMeshSession): void {
  void live.liveRawStore?.closeAndDelete();
}
