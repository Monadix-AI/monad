export const RELEASE_CHANNELS = ['stable', 'beta', 'nightly'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export function parseReleaseChannel(value: unknown): ReleaseChannel {
  if (typeof value === 'string' && RELEASE_CHANNELS.includes(value as ReleaseChannel)) return value as ReleaseChannel;
  throw new Error(`invalid release channel: ${String(value)} (expected ${RELEASE_CHANNELS.join(', ')})`);
}

export function releaseChannelOfVersion(version: string): ReleaseChannel {
  const normalized = normalizeReleaseVersion(version);
  if (/^\d+\.\d+\.\d+-nightly(?:\.|$)/.test(normalized)) return 'nightly';
  if (/^\d+\.\d+\.\d+-beta(?:\.|$)/.test(normalized)) return 'beta';
  return 'stable';
}

export function shouldInstallRelease(
  currentVersion: string,
  targetVersion: string,
  requestedChannel: ReleaseChannel,
  explicitChannelSwitch: boolean
): boolean {
  if (normalizeReleaseVersion(currentVersion) === normalizeReleaseVersion(targetVersion)) return false;
  const currentChannel = releaseChannelOfVersion(currentVersion);
  if (releaseChannelOfVersion(targetVersion) !== requestedChannel) return false;
  if (currentChannel !== requestedChannel) return explicitChannelSwitch;
  return compareReleaseVersions(targetVersion, currentVersion) > 0;
}

export function isUpgradeAvailable(currentVersion: string, targetVersion: string): boolean {
  return shouldInstallRelease(currentVersion, targetVersion, releaseChannelOfVersion(currentVersion), false);
}

export function normalizeReleaseVersion(version: string): string {
  return version.replace(/^v/, '');
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return normalizeReleaseVersion(left).localeCompare(normalizeReleaseVersion(right));
  for (let index = 0; index < 3; index += 1) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.pre[index];
    const bv = b.pre[index];
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av) ? Number(av) : null;
    const bn = /^\d+$/.test(bv) ? Number(bv) : null;
    if (an !== null && bn !== null) return Math.sign(an - bn);
    if (an !== null || bn !== null) return an !== null ? -1 : 1;
    return av.localeCompare(bv);
  }
  return 0;
}

function parseVersion(version: string): { core: number[]; pre: string[] } | null {
  const match = normalizeReleaseVersion(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.+)?$/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4]?.split('.') ?? []
  };
}
