// Parse an atom pack install spec into a typed source. Supported:
//   github:owner/repo[@<ref>] (reads prebuilt artifacts committed to the repository)
//   https://github.com/owner/repo[/blob/<ref>/...|/tree/<ref>/...]
//   local:/abs/path  | /abs/path | ./rel/path | C:\abs\path   (a staged atom pack dir, for dev/offline)

import { isAbsolute, resolve } from 'node:path';
import { type GithubSource, githubSourceIdentity, parseGithubSource, parseGithubSourceOrNull } from '@monad/utils';

export type AtomPackSource = GithubSource | { kind: 'local'; path: string; spec: string };

class AtomPackSourceError extends Error {}

/** A VERSION-INDEPENDENT identity for a source, so re-installing the same logical pack (a new release
 *  ref) updates in place rather than creating a duplicate. github drops the ref; local is keyed by
 *  path. Two different developers' packs get distinct ids
 *  even when their manifest names collide. */
export function sourceIdentity(source: AtomPackSource): string {
  switch (source.kind) {
    case 'github':
      return githubSourceIdentity(source);
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
  if (githubUrl) {
    if (trimmed.startsWith('http://')) throw new AtomPackSourceError('GitHub Atom Pack URLs must use HTTPS');
    return githubUrl;
  }

  if (trimmed.startsWith('local:')) {
    const path = trimmed.slice('local:'.length);
    if (!path) throw new AtomPackSourceError('local Atom Pack source requires a directory path');
    return { kind: 'local', path: resolve(path), spec };
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../') || isAbsolute(trimmed)) {
    return { kind: 'local', path: resolve(trimmed), spec };
  }

  throw new AtomPackSourceError(`unrecognized Atom Pack source: ${spec}`);
}
