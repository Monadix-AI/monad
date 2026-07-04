export function workdirLabel(path: string | undefined, fallback: string): string {
  if (!path) return fallback;
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).at(-1) || trimmed || fallback;
}

export function fileManagerLabel(platform?: string): string {
  if (!platform) return 'Show in file manager';
  const normalized = platform.toLowerCase();
  if (normalized.includes('mac')) return 'Show in Finder';
  if (normalized.includes('win')) return 'Show in Explorer';
  return 'Show in file manager';
}

export function terminalLabel(platform?: string): string {
  if (!platform) return 'Open in terminal';
  return platform.toLowerCase().includes('mac') ? 'Open in Terminal' : 'Open in terminal';
}
