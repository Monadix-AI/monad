// Parse an atom pack install spec into a typed source. Supported:
//   github:owner/repo@<ref>        (ref SHOULD be a commit SHA — pinned; tags are mutable)
//   https://github.com/owner/repo[/blob/<ref>/...|/tree/<ref>/...]
//   npm:<name>@<version>           (name may be @scope/name)
//   local:/abs/path  | /abs/path | ./rel/path | C:\abs\path   (a staged atom pack dir, for dev/offline)

import { isAbsolute } from 'node:path';
import { type GithubSource, githubSourceIdentity, parseGithubSource, parseGithubSourceOrNull } from '@monad/utils';

export type AtomPackSource =
  | GithubSource
  | { kind: 'npm'; name: string; version: string; spec: string }
  | { kind: 'local'; path: string; spec: string };

class AtomPackSourceError extends Error {}

/** A VERSION-INDEPENDENT identity for a source, so re-installing the same logical pack (a new commit
 *  SHA, a new npm version) updates in place rather than creating a duplicate. github drops the ref,
 *  npm drops the version; local is keyed by path. Two different developers' packs get distinct ids
 *  even when their manifest names collide. */
export function sourceIdentity(source: AtomPackSource): string {
  switch (source.kind) {
    case 'github':
      return githubSourceIdentity(source);
    case 'npm':
      return `npm:${source.name}`.toLowerCase();
    case 'local':
      return `local:${source.path}`;
  }
}

export function parseAtomPackSource(spec: string): AtomPackSource {
  const trimmed = spec.trim();

  if (trimmed.startsWith('github:')) {
    return parseGithubSource(trimmed);
  }

  const githubUrl = parseGithubSourceOrNull(trimmed);
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
