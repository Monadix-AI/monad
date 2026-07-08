// GitHub fetcher for skill installs: resolve the ref to a full commit SHA (for the version lock +
// update detection), then download the repo tarball and untar it into a path→bytes map with the
// archive's top-level `<owner>-<repo>-<sha>/` prefix stripped. If the GitHub API path is denied, fall
// back to git credentials via a shallow checkout. The injected-fetch seam lives in index.ts so
// installs are testable offline.

import type { GithubSource } from '@monad/utils';
import type { SkillFetcher, StagedSkillRepo } from '#/capabilities/skills/install/index.ts';
import type { DownloadProgress } from '#/services/download.ts';

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { untar } from '#/atoms/install/untar.ts';
import { SkillInstallError } from '#/capabilities/skills/install/index.ts';
import { daemonChildProcesses } from '#/infra/daemon-child-processes.ts';
import { downloadBytes } from '#/services/download.ts';

type SkillFetcherOptions = {
  githubToken?: string;
  onDownloadProgress?: (progress: DownloadProgress & { source: string }) => void;
};

function ghHeaders(token?: string): Record<string, string> {
  return {
    'User-Agent': 'monad',
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

function isAuthOrPermissionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /\b(401|403|404)\b/.test(err.message);
}

async function runGit(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', env: process.env, detached: true });
  daemonChildProcesses.track(proc.pid, 'skill-install:git');
  void proc.exited.then(() => daemonChildProcesses.untrack(proc.pid));
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  daemonChildProcesses.untrack(proc.pid);
  if (code !== 0) throw new SkillInstallError(stderr.trim() || `git ${args[1] ?? ''} failed`);
  return stdout.trim();
}

/** Resolve a ref (branch/tag/sha) to the full commit SHA it currently points at. */
export async function resolveGithubCommit(source: GithubSource, token?: string): Promise<string> {
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.ref)}`;
  const res = await fetch(url, { headers: { ...ghHeaders(token), Accept: 'application/vnd.github.sha' } });
  if (!res.ok)
    throw new SkillInstallError(`github: resolving ${source.owner}/${source.repo}@${source.ref} failed: ${res.status}`);
  return (await res.text()).trim();
}

async function fetchGithubTarball(source: GithubSource, opts: SkillFetcherOptions): Promise<StagedSkillRepo> {
  const commit = await resolveGithubCommit(source, opts.githubToken);
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/tarball/${commit}`;
  const { bytes } = await downloadBytes(url, {
    headers: ghHeaders(opts.githubToken),
    accept: 'application/gzip, application/x-gzip, application/octet-stream',
    allowedContentTypes: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
    onProgress: (progress) => opts.onDownloadProgress?.({ ...progress, source: url })
  }).catch((error: unknown) => {
    throw new SkillInstallError(
      `github tarball ${source.owner}/${source.repo}@${source.ref} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  });

  const archive = untar(Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>));
  // GitHub tarballs nest everything under a single `<owner>-<repo>-<sha>/` dir — strip it.
  const files = new Map<string, Uint8Array>();
  for (const [path, bytes] of archive) {
    const rest = path.slice(path.indexOf('/') + 1);
    if (rest && path.includes('/')) files.set(rest, bytes);
  }
  return { files, commit };
}

async function readCheckoutFiles(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.name === '.git') return;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          return;
        }
        if (!entry.isFile()) return;
        files.set(relative(root, path).split(sep).join('/'), await Bun.file(path).bytes());
      })
    );
  }
  await walk(root);
  return files;
}

async function fetchGithubViaGit(source: GithubSource): Promise<StagedSkillRepo> {
  const checkoutDir = await mkdtemp(join(tmpdir(), 'monad-skill-git-'));
  const repoUrl = `https://github.com/${source.owner}/${source.repo}.git`;
  try {
    if (source.path) {
      try {
        await runGit([
          'git',
          'clone',
          '--filter=blob:none',
          '--depth',
          '1',
          '--sparse',
          '--single-branch',
          '--branch',
          source.ref,
          repoUrl,
          checkoutDir
        ]);
      } catch {
        await runGit([
          'git',
          'clone',
          '--filter=blob:none',
          '--depth',
          '1',
          '--sparse',
          '--single-branch',
          repoUrl,
          checkoutDir
        ]);
        await runGit(['git', '-C', checkoutDir, 'checkout', source.ref]);
      }
      await runGit(['git', '-C', checkoutDir, 'sparse-checkout', 'set', source.path]);
    } else {
      try {
        await runGit(['git', 'clone', '--depth', '1', '--single-branch', '--branch', source.ref, repoUrl, checkoutDir]);
      } catch {
        await runGit(['git', 'clone', '--depth', '1', '--single-branch', repoUrl, checkoutDir]);
        await runGit(['git', '-C', checkoutDir, 'checkout', source.ref]);
      }
    }
    const commit = await runGit(['git', '-C', checkoutDir, 'rev-parse', 'HEAD']);
    return { files: await readCheckoutFiles(checkoutDir), commit };
  } finally {
    await rm(checkoutDir, { recursive: true, force: true });
  }
}

export function createSkillFetcher(opts: SkillFetcherOptions = {}): SkillFetcher {
  return async (source) => {
    try {
      return await fetchGithubTarball(source, opts);
    } catch (err) {
      if (!isAuthOrPermissionError(err)) throw err;
      return fetchGithubViaGit(source);
    }
  };
}
