// Parse an atom pack install spec into a typed source. Supported:
//   github:owner/repo@<ref>        (ref SHOULD be a commit SHA — pinned; tags are mutable)
//   https://github.com/owner/repo[/blob/<ref>/...|/tree/<ref>/...]
//   npm:<name>@<version>           (name may be @scope/name)
//   local:/abs/path  | /abs/path | ./rel/path | C:\abs\path   (a staged atom pack dir, for dev/offline)

import { isAbsolute, posix } from 'node:path';

export type AtomPackSource =
  | { kind: 'github'; owner: string; repo: string; ref: string; path?: string; skill?: string; spec: string }
  | { kind: 'npm'; name: string; version: string; spec: string }
  | { kind: 'local'; path: string; spec: string };

class AtomPackSourceError extends Error {}

function normalizeGithubPath(path: string): string | undefined {
  if (!path) return undefined;
  const normalized = posix.normalize(path);
  if (posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new AtomPackSourceError(`github path escapes repo: ${path}`);
  }
  return normalized === '.' ? undefined : normalized;
}

function parseGithubUrl(spec: string): Extract<AtomPackSource, { kind: 'github' }> | null {
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
      marker === 'blob' && posix.basename(filePath) === 'SKILL.md' ? posix.dirname(filePath) : filePath
    );
    return { kind: 'github', owner, repo, ref: parts[3], ...(path ? { path } : {}), ...(skill ? { skill } : {}), spec };
  }
  return { kind: 'github', owner, repo, ref: 'main', ...(skill ? { skill } : {}), spec };
}

/** A VERSION-INDEPENDENT identity for a source, so re-installing the same logical pack (a new commit
 *  SHA, a new npm version) updates in place rather than creating a duplicate. github drops the ref,
 *  npm drops the version; local is keyed by path. Two different developers' packs get distinct ids
 *  even when their manifest names collide. */
export function sourceIdentity(source: AtomPackSource): string {
  switch (source.kind) {
    case 'github':
      return `github:${source.owner}/${source.repo}${source.path ? `/${source.path}` : ''}${source.skill ? `?skill=${source.skill}` : ''}`.toLowerCase();
    case 'npm':
      return `npm:${source.name}`.toLowerCase();
    case 'local':
      return `local:${source.path}`;
  }
}

export function parseAtomPackSource(spec: string): AtomPackSource {
  const trimmed = spec.trim();

  if (trimmed.startsWith('github:')) {
    const m = trimmed.slice('github:'.length).match(/^([^/]+)\/([^@]+?)(?:@(.+))?$/);
    if (!m) throw new AtomPackSourceError(`invalid github source: ${spec} (want github:owner/repo[@<ref>])`);
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

  if (trimmed.startsWith('npm:')) {
    const rest = trimmed.slice('npm:'.length);
    // @scope/name@version  OR  name@version
    const at = rest.lastIndexOf('@');
    if (at <= 0) throw new AtomPackSourceError(`invalid npm source: ${spec} (want npm:name@version)`);
    return { kind: 'npm', name: rest.slice(0, at), version: rest.slice(at + 1), spec };
  }

  if (trimmed.startsWith('local:')) {
    return { kind: 'local', path: trimmed.slice('local:'.length), spec };
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../') || isAbsolute(trimmed)) {
    return { kind: 'local', path: trimmed, spec };
  }

  throw new AtomPackSourceError(`unrecognized atom pack source: ${spec}`);
}
