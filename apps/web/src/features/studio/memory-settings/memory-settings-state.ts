export const MEMORY_TABS = ['settings', 'facts', 'graph', 'laws'] as const;
export type MemoryTab = (typeof MEMORY_TABS)[number];

export function mem0Activation(qdrant: { installed: boolean } | undefined): 'activate' | 'confirm' {
  return qdrant && !qdrant.installed ? 'confirm' : 'activate';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${Number(value.toFixed(1))} ${unit}`;
}

export function formatMemoryDownloadProgress(
  loadedBytes: number,
  totalBytes: number | null
): { loaded: string; total: string | null; percent: number | null } {
  return {
    loaded: formatBytes(loadedBytes),
    total: totalBytes === null ? null : formatBytes(totalBytes),
    percent: totalBytes && totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : null
  };
}
