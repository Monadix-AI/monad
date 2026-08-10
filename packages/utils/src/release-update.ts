import { posix, win32 } from 'node:path';

import { compareReleaseVersions, normalizeReleaseVersion, type ReleaseChannel } from './release-version.ts';

export * from './release-version.ts';

export interface ResolvedRelease {
  tag: string;
  version: string;
  notes: string | null;
}

export type ReleaseFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export interface ResolveReleaseOptions {
  apiBaseUrl?: string;
  downloadBaseUrl?: string;
  fetch?: ReleaseFetch;
  repository?: string;
  userAgent?: string;
}

interface GithubRelease {
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  tag_name?: unknown;
}

const DEFAULT_REPOSITORY = 'Monadix-AI/monad';

export function monadUpdaterPath(binaryPath: string, platform: NodeJS.Platform = process.platform): string {
  const targetPath = platform === 'win32' ? win32 : posix;
  return targetPath.join(targetPath.dirname(binaryPath), platform === 'win32' ? 'monad-update.exe' : 'monad-update');
}

export async function resolveRelease(
  channel: ReleaseChannel,
  options: ResolveReleaseOptions = {}
): Promise<ResolvedRelease | null> {
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const apiBaseUrl = options.apiBaseUrl ?? `https://api.github.com/repos/${repository}`;
  const downloadBaseUrl = options.downloadBaseUrl ?? 'https://github.com';
  const fetchImpl = options.fetch ?? fetch;
  const headers = { 'User-Agent': options.userAgent ?? 'monad-updater' };

  if (channel === 'stable') {
    const response = await fetchImpl(`${apiBaseUrl}/releases/latest`, { headers });
    if (response.ok) return githubRelease(await response.json());
    const redirect = await fetchImpl(`${downloadBaseUrl}/${repository}/releases/latest`, {
      headers,
      redirect: 'manual'
    });
    const location = redirect.headers.get('location') ?? redirect.url;
    const tag = location.match(/\/releases\/tag\/([^/?#]+)/)?.[1];
    return tag ? { tag, version: normalizeReleaseVersion(tag), notes: null } : null;
  }

  const response = await fetchImpl(`${apiBaseUrl}/releases?per_page=50`, { headers });
  if (!response.ok) return null;
  const payload: unknown = await response.json();
  const releases = Array.isArray(payload) ? payload : [];
  const candidates = releases.flatMap((value) => {
    const release = githubRelease(value);
    if (!release || !isChannelTag(release.tag, channel)) return [];
    const raw = value as GithubRelease;
    if (raw.draft === true || raw.prerelease !== true) return [];
    return [release];
  });
  return candidates.sort((a, b) => compareReleaseVersions(b.version, a.version))[0] ?? null;
}

export async function resolveReleaseTag(
  tag: string,
  options: ResolveReleaseOptions = {}
): Promise<ResolvedRelease | null> {
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const apiBaseUrl = options.apiBaseUrl ?? `https://api.github.com/repos/${repository}`;
  const downloadBaseUrl = options.downloadBaseUrl ?? 'https://github.com';
  const fetchImpl = options.fetch ?? fetch;
  const headers = { 'User-Agent': options.userAgent ?? 'monad-updater' };
  const normalizedTag = tag.startsWith('v') ? tag : `v${tag}`;

  if (
    !/^v\d+\.\d+\.\d+(?:-(?:beta|nightly)(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      normalizedTag
    )
  )
    return null;

  const response = await fetchImpl(`${apiBaseUrl}/releases/tags/${encodeURIComponent(normalizedTag)}`, { headers });
  if (response.ok) return githubRelease(await response.json());

  const releasePage = await fetchImpl(
    `${downloadBaseUrl}/${repository}/releases/tag/${encodeURIComponent(normalizedTag)}`,
    {
      headers,
      redirect: 'manual'
    }
  );
  return releasePage.ok ? { tag: normalizedTag, version: normalizeReleaseVersion(normalizedTag), notes: null } : null;
}

function githubRelease(value: unknown): ResolvedRelease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const release = value as GithubRelease;
  if (typeof release.tag_name !== 'string') return null;
  return {
    tag: release.tag_name,
    version: normalizeReleaseVersion(release.tag_name),
    notes: typeof release.body === 'string' ? release.body : null
  };
}

function isChannelTag(tag: string, channel: Exclude<ReleaseChannel, 'stable'>): boolean {
  return new RegExp(`^v?\\d+\\.\\d+\\.\\d+-${channel}(?:\\.|$)`).test(tag);
}
