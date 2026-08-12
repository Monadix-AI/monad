import { compareReleaseVersions, normalizeReleaseVersion, type ReleaseChannel } from './release-version.ts';

export * from './release-version.ts';

export interface ResolvedRelease {
  tag: string;
  version: string;
  notes: string | null;
  immutable: boolean;
  assets: ResolvedReleaseAsset[];
}

export interface ResolvedReleaseAsset {
  name: string;
  url: string;
  size: number;
  digest: string | null;
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
  assets?: unknown;
  body?: unknown;
  draft?: unknown;
  immutable?: unknown;
  prerelease?: unknown;
  tag_name?: unknown;
}

interface GithubReleaseAsset {
  browser_download_url?: unknown;
  digest?: unknown;
  name?: unknown;
  size?: unknown;
}

const DEFAULT_REPOSITORY = 'Monadix-AI/monad';

export async function resolveRelease(
  channel: ReleaseChannel,
  options: ResolveReleaseOptions = {}
): Promise<ResolvedRelease | null> {
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const apiBaseUrl = options.apiBaseUrl ?? `https://api.github.com/repos/${repository}`;
  const downloadBaseUrl = options.downloadBaseUrl ?? 'https://github.com';
  const fetchImpl = options.fetch ?? fetch;
  const headers = { 'User-Agent': options.userAgent ?? 'monad-upgrade' };

  if (channel === 'stable') {
    const response = await fetchImpl(`${apiBaseUrl}/releases/latest`, { headers });
    if (response.ok) return githubRelease(await response.json());
    const redirect = await fetchImpl(`${downloadBaseUrl}/${repository}/releases/latest`, {
      headers,
      redirect: 'manual'
    });
    const location = redirect.headers.get('location') ?? redirect.url;
    const tag = location.match(/\/releases\/tag\/([^/?#]+)/)?.[1];
    return tag ? { tag, version: normalizeReleaseVersion(tag), notes: null, immutable: false, assets: [] } : null;
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
  const headers = { 'User-Agent': options.userAgent ?? 'monad-upgrade' };
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
  return releasePage.ok
    ? { tag: normalizedTag, version: normalizeReleaseVersion(normalizedTag), notes: null, immutable: false, assets: [] }
    : null;
}

function githubRelease(value: unknown): ResolvedRelease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const release = value as GithubRelease;
  if (typeof release.tag_name !== 'string') return null;
  return {
    tag: release.tag_name,
    version: normalizeReleaseVersion(release.tag_name),
    notes: typeof release.body === 'string' ? release.body : null,
    immutable: release.immutable === true,
    assets: Array.isArray(release.assets) ? release.assets.flatMap(githubReleaseAsset) : []
  };
}

function githubReleaseAsset(value: unknown): ResolvedReleaseAsset[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const asset = value as GithubReleaseAsset;
  if (
    typeof asset.name !== 'string' ||
    typeof asset.browser_download_url !== 'string' ||
    typeof asset.size !== 'number' ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 0
  )
    return [];
  return [
    {
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      digest: typeof asset.digest === 'string' ? asset.digest : null
    }
  ];
}

function isChannelTag(tag: string, channel: Exclude<ReleaseChannel, 'stable'>): boolean {
  return new RegExp(`^v?\\d+\\.\\d+\\.\\d+-${channel}(?:\\.|$)`).test(tag);
}
