import type { CommandDef } from './types.ts';

import { cp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths } from '@monad/home';
import { MONAD_VERSION } from '@monad/protocol';

import { t } from '../lib/i18n.ts';
import { bold, dim, green, json, out, yellow } from '../lib/output.ts';

const RELEASE_REPOSITORY = 'Monadix-AI/monad';

interface ReleaseInfo {
  tag_name: string;
}

interface ResolvedRelease {
  tag: string;
  version: string;
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface UpgradeCommandDeps {
  binaryPath?: string | (() => string);
  platform?: NodeJS.Platform;
  releaseApiBaseUrl?: string;
  releaseDownloadBaseUrl?: string;
  installScriptUrl?: string;
  installerEnv?: Record<string, string>;
  fetch?: FetchFn;
}

interface ResolvedUpgradeCommandDeps {
  binaryPath: () => string;
  platform: NodeJS.Platform;
  installScriptName: string;
  releaseApiBaseUrl: string;
  releaseDownloadBaseUrl: string;
  installScriptUrl: string | null;
  installerEnv: Record<string, string>;
  fetch: FetchFn;
}

function resolveDeps(deps: UpgradeCommandDeps = {}): ResolvedUpgradeCommandDeps {
  const binaryPath = deps.binaryPath;
  const platform = deps.platform ?? process.platform;
  const installScriptName = platform === 'win32' ? 'install.ps1' : 'install.sh';
  return {
    binaryPath: typeof binaryPath === 'function' ? binaryPath : () => binaryPath ?? process.execPath,
    platform,
    installScriptName,
    releaseApiBaseUrl: deps.releaseApiBaseUrl ?? `https://api.github.com/repos/${RELEASE_REPOSITORY}`,
    releaseDownloadBaseUrl: deps.releaseDownloadBaseUrl ?? 'https://github.com',
    installScriptUrl: deps.installScriptUrl ?? null,
    installerEnv: deps.installerEnv ?? {},
    fetch: deps.fetch ?? ((...args) => globalThis.fetch(...args))
  };
}

function normalizeReleaseVersion(tag: string): string {
  return tag.replace(/^v/, '');
}

async function fetchLatestRelease(channel: string, deps: ResolvedUpgradeCommandDeps): Promise<ResolvedRelease | null> {
  try {
    const headers = { 'User-Agent': 'monad-cli' };
    if (channel === 'stable') {
      const res = await deps.fetch(`${deps.releaseApiBaseUrl}/releases/latest`, { headers });
      if (!res.ok) return fetchStableReleaseFromRedirect(deps);
      const data = (await res.json()) as ReleaseInfo;
      return data.tag_name ? { tag: data.tag_name, version: normalizeReleaseVersion(data.tag_name) } : null;
    }
    const res = await deps.fetch(`${deps.releaseApiBaseUrl}/releases?per_page=50`, { headers });
    if (!res.ok) return null;
    const releases = (await res.json()) as Array<{ tag_name?: string; prerelease?: boolean }>;
    for (const rel of releases) {
      if (channel === 'beta' && rel.prerelease && rel.tag_name) {
        return { tag: rel.tag_name, version: normalizeReleaseVersion(rel.tag_name) };
      }
      if (channel === 'nightly' && rel.tag_name?.includes('nightly')) {
        return { tag: rel.tag_name, version: normalizeReleaseVersion(rel.tag_name) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchStableReleaseFromRedirect(deps: ResolvedUpgradeCommandDeps): Promise<ResolvedRelease | null> {
  try {
    const res = await deps.fetch(`${deps.releaseDownloadBaseUrl}/${RELEASE_REPOSITORY}/releases/latest`, {
      headers: { 'User-Agent': 'monad-cli' },
      redirect: 'manual'
    });
    const location = res.headers.get('location') ?? res.url;
    const tag = location.match(/\/releases\/tag\/([^/?#]+)/)?.[1];
    return tag ? { tag, version: normalizeReleaseVersion(tag) } : null;
  } catch {
    return null;
  }
}

async function fetchInstallScriptHash(tag: string, deps: ResolvedUpgradeCommandDeps): Promise<string> {
  try {
    const res = await deps.fetch(
      `${deps.releaseDownloadBaseUrl}/${RELEASE_REPOSITORY}/releases/download/${tag}/${deps.installScriptName}.sha256`,
      {
        headers: { 'User-Agent': 'monad-cli' }
      }
    );
    if (!res.ok) throw new Error(`missing ${deps.installScriptName}.sha256: HTTP ${res.status}`);
    const text = await res.text();
    const hash = text.trim().split(/\s+/)[0];
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error(`invalid ${deps.installScriptName}.sha256`);
    return hash.toLowerCase();
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error(`failed to fetch ${deps.installScriptName}.sha256`);
  }
}

async function fetchReleaseNotes(channel: string, deps: ResolvedUpgradeCommandDeps): Promise<string | null> {
  try {
    const headers = { 'User-Agent': 'monad-cli' };
    if (channel === 'stable') {
      const res = await deps.fetch(`${deps.releaseApiBaseUrl}/releases/latest`, { headers });
      if (!res.ok) return null;
      const data = (await res.json()) as { body?: string };
      return data.body ?? null;
    }
    const res = await deps.fetch(`${deps.releaseApiBaseUrl}/releases?per_page=10`, { headers });
    if (!res.ok) return null;
    const releases = (await res.json()) as Array<{ tag_name?: string; prerelease?: boolean; body?: string }>;
    for (const rel of releases) {
      if (channel === 'beta' && rel.prerelease) return rel.body ?? null;
      if (channel === 'nightly' && rel.tag_name?.includes('nightly')) return rel.body ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

export function createUpgradeCommand(commandDeps: UpgradeCommandDeps = {}): CommandDef {
  const deps = resolveDeps(commandDeps);
  return {
    local: true,
    name: 'upgrade',
    synopsis: 'upgrade [rollback] [--check] [--channel <stable|beta|nightly>]',
    description: 'check for and apply monad updates; rollback reverts the last upgrade',
    descriptionKey: 'cli.cmd.upgrade.desc',
    flags: {
      check: {
        type: 'boolean',
        description: 'check for updates without applying them',
        descriptionKey: 'cli.cmd.upgrade.checkFlag'
      },
      channel: {
        type: 'string',
        description: 'release channel: stable (default), beta, or nightly',
        descriptionKey: 'cli.cmd.upgrade.channelFlag'
      },
      'prune-backups': {
        type: 'boolean',
        description: 'remove all but the 3 most recent binary backups and exit',
        descriptionKey: 'cli.cmd.upgrade.pruneFlag'
      },
      notes: {
        type: 'boolean',
        description: 'show release notes alongside version info',
        descriptionKey: 'cli.cmd.upgrade.notesFlag'
      }
    },
    async run({ positionals, flags, globals }) {
      const sub = positionals[0];

      if (sub === 'rollback') {
        await runRollback(globals.json, deps);
        return;
      }

      if (flags['prune-backups'] === true) {
        await pruneBackups(3);
        return;
      }

      const channel = (flags.channel as string | undefined) ?? 'stable';
      const checkOnly = flags.check === true;

      out(t('cli.upgrade.checking'));

      const latestRelease = await fetchLatestRelease(channel, deps);
      if (!latestRelease) {
        out(yellow(t('cli.upgrade.fetchFailed')));
        process.exit(1);
      }

      const current = MONAD_VERSION;
      const latest = latestRelease.version;
      const upToDate = current === latest;

      if (globals.json) {
        json({ current, latest, upToDate, channel });
        return;
      }

      if (upToDate) {
        out(`${green('✓')} ${t('cli.upgrade.upToDate', { version: bold(current) })}`);
        return;
      }

      out(t('cli.upgrade.available', { current: bold(current), latest: bold(latest) }));

      if (flags.notes === true) {
        const notes = await fetchReleaseNotes(channel, deps);
        if (notes) {
          out('');
          // Truncate to first 20 lines so it doesn't flood the terminal
          const lines = notes.split('\n').slice(0, 20);
          for (const line of lines) out(dim(line));
          if (notes.split('\n').length > 20) out(dim('…'));
          out('');
        }
      }

      if (checkOnly) return;

      out(dim(t('cli.upgrade.applying')));

      await backupBinary(current, deps);

      const scriptPath = join(tmpdir(), `monad-install-${Date.now()}-${deps.installScriptName}`);
      try {
        const scriptUrl =
          deps.installScriptUrl ??
          `${deps.releaseDownloadBaseUrl}/${RELEASE_REPOSITORY}/releases/download/${latestRelease.tag}/${deps.installScriptName}`;
        const res = await deps.fetch(scriptUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const script = await res.text();
        if (!isExpectedInstallScript(script, deps)) throw new Error(`unexpected ${deps.installScriptName} content`);
        await writeFile(scriptPath, script, { mode: 0o700 });

        const expectedHash = await fetchInstallScriptHash(latestRelease.tag, deps);
        const fileBytes = await Bun.file(scriptPath).arrayBuffer();
        const hasher = new Bun.CryptoHasher('sha256');
        hasher.update(fileBytes);
        const actualHash = hasher.digest('hex');
        if (actualHash !== expectedHash) {
          out(yellow(t('cli.upgrade.hashMismatch', { expected: expectedHash, actual: actualHash })));
          await import('node:fs/promises').then((m) => m.unlink(scriptPath)).catch(() => {});
          process.exit(1);
        }
        out(dim(t('cli.upgrade.hashOk')));
      } catch (err) {
        await import('node:fs/promises').then((m) => m.unlink(scriptPath)).catch(() => {});
        out(yellow(t('cli.upgrade.scriptFetchFailed', { err: String(err) })));
        process.exit(1);
      }

      const proc = Bun.spawn(installerArgs(scriptPath, channel, deps, latest), {
        stdout: 'inherit',
        stderr: 'inherit',
        stdin: 'inherit',
        env: installerEnv(channel, deps, latest)
      });
      const code = await proc.exited;
      // clean up temp script regardless of exit code
      await import('node:fs/promises').then((m) => m.unlink(scriptPath)).catch(() => {});
      // code is null when the process was killed by a signal (e.g. SIGKILL); treat that as failure
      if (code == null || code !== 0) process.exit(code ?? 1);
    }
  };
}

export const command: CommandDef = createUpgradeCommand();

function isExpectedInstallScript(script: string, deps: ResolvedUpgradeCommandDeps): boolean {
  const trimmed = script.trimStart();
  if (deps.platform === 'win32') return trimmed.startsWith('<#') || trimmed.startsWith('#Requires');
  return trimmed.startsWith('#!');
}

function installerArgs(
  scriptPath: string,
  channel: string,
  deps: ResolvedUpgradeCommandDeps,
  version: string
): string[] {
  if (deps.platform === 'win32') {
    return ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  }
  return ['bash', scriptPath, '--version', version, ...(channel !== 'stable' ? ['--channel', channel] : [])];
}

function installerEnv(channel: string, deps: ResolvedUpgradeCommandDeps, version?: string): Record<string, string> {
  return {
    ...process.env,
    MONAD_UPGRADE_TARGET: deps.binaryPath(),
    ...(version ? { MONAD_VERSION: version } : {}),
    ...(deps.platform === 'win32' && channel !== 'stable' ? { MONAD_CHANNEL: channel } : {}),
    ...deps.installerEnv
  };
}

async function backupBinary(currentVersion: string, deps: ResolvedUpgradeCommandDeps): Promise<void> {
  const paths = getPaths();
  const backupDir = join(paths.backup, 'binaries');
  await mkdir(backupDir, { recursive: true });
  const dest = join(backupDir, `monad-${currentVersion}`);
  try {
    await cp(deps.binaryPath(), dest);
    out(dim(t('cli.upgrade.backedUp', { path: dest })));
  } catch {
    // non-fatal — backup is best-effort
  }

  // Prune old binary backups — keep only the 5 most recent
  try {
    const { readdir, stat, unlink: rm } = await import('node:fs/promises');
    const files = (await readdir(backupDir, { withFileTypes: true })).filter(
      (e) => e.isFile() && e.name.startsWith('monad-')
    );
    if (files.length > 5) {
      const withMtime = await Promise.all(
        files.map(async (e) => ({ name: e.name, mtime: (await stat(join(backupDir, e.name))).mtime.getTime() }))
      );
      const sorted = withMtime.sort((a, b) => b.mtime - a.mtime);
      for (const old of sorted.slice(5)) {
        await rm(join(backupDir, old.name)).catch(() => {});
      }
    }
  } catch {
    /* non-fatal */
  }
}

async function runRollback(asJson: boolean, deps: ResolvedUpgradeCommandDeps): Promise<void> {
  const paths = getPaths();
  const backupDir = join(paths.backup, 'binaries');

  // Find all backup files, pick the most-recently-modified
  let entries: { name: string; mtime: number }[] = [];
  try {
    const dir = await import('node:fs/promises').then((m) => m.readdir(backupDir, { withFileTypes: true }));
    const stats = await Promise.all(
      dir
        .filter((e) => e.isFile() && e.name.startsWith('monad-'))
        .map(async (e) => {
          const { mtime } = await import('node:fs/promises').then((m) => m.stat(join(backupDir, e.name)));
          return { name: e.name, mtime: mtime.getTime() };
        })
    );
    entries = stats.sort((a, b) => b.mtime - a.mtime);
  } catch {
    /* no backup dir yet */
  }

  const latest = entries.at(0);
  if (!latest) {
    out(yellow(t('cli.upgrade.noBackup')));
    if (asJson) json({ ok: false, reason: 'no-backup' });
    return;
  }

  const src = join(backupDir, latest.name);
  try {
    await cp(src, deps.binaryPath(), { force: true });
    out(green(t('cli.upgrade.rolledBack', { name: latest.name })));
    if (asJson) json({ ok: true, restoredFrom: latest.name });
  } catch (err) {
    out(yellow(t('cli.upgrade.rollbackFailed', { err: String(err) })));
    if (asJson) json({ ok: false, reason: String(err) });
    process.exit(1);
  }
}

async function pruneBackups(keep: number): Promise<void> {
  const paths = getPaths();
  const backupDir = join(paths.backup, 'binaries');
  try {
    const { readdir, stat, unlink: rm } = await import('node:fs/promises');
    const files = (await readdir(backupDir, { withFileTypes: true })).filter(
      (e) => e.isFile() && e.name.startsWith('monad-')
    );
    const withMtime = await Promise.all(
      files.map(async (e) => ({ name: e.name, mtime: (await stat(join(backupDir, e.name))).mtime.getTime() }))
    );
    const sorted = withMtime.sort((a, b) => b.mtime - a.mtime);
    const toDelete = sorted.slice(keep);
    for (const f of toDelete) await rm(join(backupDir, f.name)).catch(() => {});
    out(green(t('cli.upgrade.pruned', { deleted: toDelete.length, kept: Math.min(files.length, keep) })));
  } catch {
    out(yellow(t('cli.upgrade.noBackup')));
  }
}
