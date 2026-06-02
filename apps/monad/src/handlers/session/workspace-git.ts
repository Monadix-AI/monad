import type { WorkspaceGit } from '@monad/protocol';

import { buildSandboxPolicy, sandboxedSpawn, sandboxLauncher } from '#/capabilities/tools';

/** Parse `git status --porcelain=v1 --branch` output. The first `## ` line carries the branch and
 *  ahead/behind counts; any other line means the tree is dirty. */
function parseGitStatus(out: string, remoteUrl?: string): WorkspaceGit {
  const lines = out.split('\n').filter((l) => l.length > 0);
  const head = lines.find((l) => l.startsWith('## '))?.slice(3) ?? '';
  const dirty = lines.some((l) => !l.startsWith('## '));
  let branch: string | undefined;
  if (head.startsWith('HEAD (no branch)')) branch = 'HEAD';
  else if (head.startsWith('No commits yet on ')) branch = head.slice('No commits yet on '.length).trim();
  else branch = head.split('...')[0]?.split(' ')[0] || undefined;
  const ahead = /\bahead (\d+)/.exec(head)?.[1];
  const behind = /\bbehind (\d+)/.exec(head)?.[1];
  return {
    isRepo: true,
    branch,
    dirty,
    ...(ahead ? { ahead: Number(ahead) } : {}),
    ...(behind ? { behind: Number(behind) } : {}),
    ...(remoteUrl ? { remoteUrl } : {})
  };
}

function normalizeGitRemote(value: string): string | undefined {
  const remote = value.trim();
  if (!remote) return undefined;
  const ssh = /^git@github\.com:(.+?)(?:\.git)?$/.exec(remote);
  if (ssh?.[1]) return `https://github.com/${ssh[1]}`;
  if (remote.startsWith('https://github.com/')) return remote.replace(/\.git$/, '');
  return undefined;
}

/** Read a read-only git summary of `cwd`. Runs git through the OS sandbox seam (never bare spawn),
 *  with `--no-optional-locks` so a status check never writes an index lock. Any failure (not a repo,
 *  git missing, sandbox denied) collapses to `{ isRepo: false }` — this is a best-effort UI hint. */
export async function readWorkspaceGit(cwd: string): Promise<WorkspaceGit> {
  try {
    // Confine through the OS sandbox when a launcher is active; otherwise fall back to a plain spawn
    // rather than failing closed (mirrors the git-clone path). A read-only status on the owner's own
    // folder is low risk, so degrading to unconfined keeps the badge working on hosts without a launcher.
    const launcher = sandboxLauncher();
    const confine = launcher.kind !== 'none' && (launcher.isAvailable?.() ?? true);
    const proc = sandboxedSpawn(
      // `-c core.fsmonitor=` neutralizes a repo-local fsmonitor program (the one config `git status`
      // would otherwise execute), so reading the badge for a hostile repo can't run its code.
      ['git', '-c', 'core.fsmonitor=', '--no-optional-locks', '-C', cwd, 'status', '--porcelain=v1', '--branch'],
      { stdout: 'pipe', stderr: 'pipe' },
      buildSandboxPolicy([cwd]),
      { confine }
    );
    const remoteProc = sandboxedSpawn(
      ['git', '-c', 'core.fsmonitor=', '--no-optional-locks', '-C', cwd, 'remote', 'get-url', 'origin'],
      { stdout: 'pipe', stderr: 'pipe' },
      buildSandboxPolicy([cwd]),
      { confine }
    );
    const [stdout, , exitCode, remoteStdout, , remoteExitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
      new Response(remoteProc.stdout).text(),
      new Response(remoteProc.stderr).text(),
      remoteProc.exited
    ]);
    if (exitCode !== 0) return { isRepo: false };
    return parseGitStatus(stdout, remoteExitCode === 0 ? normalizeGitRemote(remoteStdout) : undefined);
  } catch {
    return { isRepo: false };
  }
}
