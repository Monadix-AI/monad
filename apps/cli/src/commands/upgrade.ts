import type { CommandDef } from './types.ts';

import { cp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths } from '@monad/home';
import { MONAD_VERSION } from '@monad/protocol';

import { t } from '../lib/i18n.ts';
import { bold, dim, green, json, out, yellow } from '../lib/output.ts';

const GITHUB_REPO = 'monadix-labs/monad';

interface ReleaseInfo {
  tag_name: string;
}

async function fetchLatestVersion(channel: string): Promise<string | null> {
  try {
    const headers = { 'User-Agent': 'monad-cli' };
    if (channel === 'stable') {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { headers });
      if (!res.ok) return null;
      const data = (await res.json()) as ReleaseInfo;
      return data.tag_name ?? null;
    }
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=50`, { headers });
    if (!res.ok) return null;
    const releases = (await res.json()) as Array<{ tag_name?: string; prerelease?: boolean }>;
    for (const rel of releases) {
      if (channel === 'beta' && rel.prerelease) return rel.tag_name ?? null;
      if (channel === 'nightly' && rel.tag_name?.includes('nightly')) return rel.tag_name ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchInstallScriptHash(tag: string): Promise<string | null> {
  try {
    const res = await fetch(`https://github.com/${GITHUB_REPO}/releases/download/${tag}/install.sh.sha256`, {
      headers: { 'User-Agent': 'monad-cli' }
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.trim().split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

async function fetchReleaseNotes(channel: string): Promise<string | null> {
  try {
    const headers = { 'User-Agent': 'monad-cli' };
    if (channel === 'stable') {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { headers });
      if (!res.ok) return null;
      const data = (await res.json()) as { body?: string };
      return data.body ?? null;
    }
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`, { headers });
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

export const command: CommandDef = {
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
      await runRollback(globals.json);
      return;
    }

    if (flags['prune-backups'] === true) {
      await pruneBackups(3);
      return;
    }

    const channel = (flags.channel as string | undefined) ?? 'stable';
    const checkOnly = flags.check === true;

    out(t('cli.upgrade.checking'));

    const latest = await fetchLatestVersion(channel);
    if (!latest) {
      out(yellow(t('cli.upgrade.fetchFailed')));
      process.exit(1);
    }

    const current = MONAD_VERSION;
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
      const notes = await fetchReleaseNotes(channel);
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

    // Back up the current binary before overwriting it
    await backupBinary(current);

    const scriptPath = join(tmpdir(), `monad-install-${Date.now()}.sh`);
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/scripts/install.sh`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const script = await res.text();
      if (!script.trim().startsWith('#!')) throw new Error('unexpected install.sh content');
      await writeFile(scriptPath, script, { mode: 0o700 });

      // Verify SHA-256 if available (best-effort — a missing hash file doesn't block the upgrade).
      // Hash the on-disk bytes (not the in-memory string) so the verified content matches what bash executes.
      const expectedHash = await fetchInstallScriptHash(latest);
      if (expectedHash) {
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
      }
    } catch (err) {
      out(yellow(t('cli.upgrade.scriptFetchFailed', { err: String(err) })));
      process.exit(1);
    }

    const proc = Bun.spawn(['bash', scriptPath, ...(channel !== 'stable' ? ['--channel', channel] : [])], {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
      env: { ...process.env }
    });
    const code = await proc.exited;
    // clean up temp script regardless of exit code
    await import('node:fs/promises').then((m) => m.unlink(scriptPath)).catch(() => {});
    // code is null when the process was killed by a signal (e.g. SIGKILL); treat that as failure
    if (code == null || code !== 0) process.exit(code ?? 1);
  }
};

async function backupBinary(currentVersion: string): Promise<void> {
  const paths = getPaths();
  const backupDir = join(paths.backup, 'binaries');
  await mkdir(backupDir, { recursive: true });
  const dest = join(backupDir, `monad-${currentVersion}`);
  try {
    await cp(process.execPath, dest);
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

async function runRollback(asJson: boolean): Promise<void> {
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
    await cp(src, process.execPath, { force: true });
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
