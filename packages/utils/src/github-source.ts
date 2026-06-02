export interface GithubSource {
  kind: 'github';
  owner: string;
  repo: string;
  ref: string;
  path?: string;
  skill?: string;
  spec: string;
}

export interface GithubReleaseSource {
  owner: string;
  repo: string;
  tag: string;
  spec: string;
}

export class GithubSourceError extends Error {}

export function normalizeGithubPath(path: string): string | undefined {
  if (!path) return undefined;
  if (path.startsWith('/')) {
    throw new GithubSourceError(`github path escapes repo: ${path}`);
  }
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) throw new GithubSourceError(`github path escapes repo: ${path}`);
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : segments.join('/');
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? '';
}

function dirname(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).join('/');
}

function parseGithubUrl(spec: string): GithubSource | null {
  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname !== 'github.com') return null;

  let parts: string[];
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const owner = parts[0];
  const repoPart = parts[1];
  if (!owner || !repoPart) return null;

  const repo = repoPart.replace(/\.git$/, '');
  if (!repo) return null;
  const skill = url.searchParams.get('skill')?.trim() || undefined;

  const marker = parts[2];
  if ((marker === 'blob' || marker === 'tree') && parts[3]) {
    const filePath = parts.slice(4).join('/');
    const path = normalizeGithubPath(
      marker === 'blob' && basename(filePath) === 'SKILL.md' ? dirname(filePath) : filePath
    );
    return { kind: 'github', owner, repo, ref: parts[3], ...(path ? { path } : {}), ...(skill ? { skill } : {}), spec };
  }
  return { kind: 'github', owner, repo, ref: 'main', ...(skill ? { skill } : {}), spec };
}

export function parseGithubSource(spec: string): GithubSource {
  const trimmed = spec.trim();

  if (trimmed.startsWith('github:')) {
    const m = trimmed.slice('github:'.length).match(/^([^/]+)\/([^@]+?)(?:@(.+))?$/);
    if (!m) throw new GithubSourceError(`invalid github source: ${spec} (want github:owner/repo[@<ref>])`);
    const refAndPath = (m[3] as string | undefined) ?? 'main';
    const [ref = 'main', ...pathParts] = refAndPath.split('/');
    const path = normalizeGithubPath(pathParts.join('/'));
    return {
      kind: 'github',
      owner: m[1] as string,
      repo: m[2] as string,
      ref,
      ...(path ? { path } : {}),
      spec
    };
  }

  const githubUrl = parseGithubUrl(trimmed);
  if (githubUrl) return githubUrl;

  throw new GithubSourceError(`unrecognized github source: ${spec}`);
}

export function parseGithubSourceOrNull(spec: string): GithubSource | null {
  try {
    return parseGithubSource(spec);
  } catch {
    return null;
  }
}

export function githubSourceIdentity(source: GithubSource): string {
  return `github:${source.owner}/${source.repo}${source.path ? `/${source.path}` : ''}${source.skill ? `?skill=${source.skill}` : ''}`.toLowerCase();
}

export function parseGithubReleaseSource(spec: string): GithubReleaseSource {
  const trimmed = spec.trim();
  const m = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@(.+)$/);
  if (!m || !(m[3] as string).trim()) {
    throw new GithubSourceError(`invalid github release source: ${spec} (want owner/repo@tag)`);
  }
  return {
    owner: m[1] as string,
    repo: m[2] as string,
    tag: m[3] as string,
    spec
  };
}

export function parseGithubReleaseSourceOrNull(spec: string): GithubReleaseSource | null {
  try {
    return parseGithubReleaseSource(spec);
  } catch {
    return null;
  }
}
