import { cp, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyAuth, getPaths, initMonadHome, loadAll, saveAuth } from '@monad/environment';

import { stopDaemon } from '../../lib/daemon.ts';
import { t } from '../../lib/i18n.ts';
import { ask } from '../../lib/init-flow.ts';
import { dim, green, json, out, yellow } from '../../lib/output.ts';

async function confirm(message: string, skipConfirm: boolean): Promise<boolean> {
  if (skipConfirm) return true;
  return /^y$/i.test(await ask(`${message} [y/N] `));
}

async function silentUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Copy files to ~/.monad/backup/<timestamp>/ before destructive ops. */
async function backupFiles(label: string, files: string[]): Promise<string> {
  const paths = getPaths();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(paths.backup, `purge-${label}-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  await Promise.all(
    files.map(async (src) => {
      const dest = join(backupDir, src.split('/').pop() ?? src);
      try {
        await cp(src, dest);
      } catch {
        /* skip missing files */
      }
    })
  );
  return backupDir;
}

export async function purgeSessions(keepLast: number, yes: boolean): Promise<void> {
  const paths = getPaths();
  out(dim(keepLast > 0 ? t('cli.purgeCmd.sessions.keepWarning', { n: keepLast }) : t('cli.purgeCmd.sessions.warning')));
  if (!(await confirm(t('cli.purgeCmd.sessions.confirm'), yes))) {
    out(yellow(t('cli.aborted')));
    return;
  }

  // Operate directly on the SQLite file — no live daemon needed, and O(1) regardless of session
  // count. The daemon must be stopped first so the WAL is flushed.
  await stopDaemon();
  const backupDir = await backupFiles('sessions', [paths.db]);
  out(dim(t('cli.purgeCmd.backedUpTo', { path: backupDir })));

  if (keepLast > 0) {
    const { Database } = await import('bun:sqlite');
    const db = new Database(paths.db, { readonly: false });
    try {
      const deleted = db
        .prepare('DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY created_at DESC LIMIT ?)')
        .run(keepLast);
      json({ purged: 'sessions', keptLast: keepLast, deleted: deleted.changes, backupDir });
      out(green(t('cli.purgeCmd.sessions.deletedN', { count: deleted.changes })));
    } finally {
      db.close();
    }
  } else {
    await silentUnlink(paths.db);
    json({ purged: 'sessions', keptLast: 0, backupDir });
    out(green(t('cli.purgeCmd.sessions.done')));
  }
  out(dim(t('cli.purge.restartHint')));
}

export async function purgeConfig(yes: boolean): Promise<void> {
  const paths = getPaths();
  const existing = await loadAll(paths);
  if (existing) {
    out(t('cli.purgeCmd.config.current'));
    out(dim(`  user:  ${existing.user.displayName}`));
    out(dim(`  default model: ${existing.model.default || '(none)'}`));
    out(dim(`  providers:  ${existing.model.providers.map((p) => p.label).join(', ') || '(none)'}`));
    out(dim(`  port:  ${existing.network.port}  transport: ${existing.network.transport}`));
    out(dim(`  channels:   ${existing.channels.length}`));
    out('');
  }
  out(dim(t('cli.purgeCmd.config.warning')));
  if (!(await confirm(t('cli.purgeCmd.config.confirm'), yes))) {
    out(yellow(t('cli.aborted')));
    return;
  }
  await stopDaemon();
  const backupDir = await backupFiles('config', [paths.config, paths.agentsConfig]);
  out(dim(t('cli.purgeCmd.backedUpTo', { path: backupDir })));
  await Promise.all([silentUnlink(paths.config), silentUnlink(paths.agentsConfig)]);
  await initMonadHome(paths);
  json({ purged: 'config', backupDir });
  out(green(t('cli.purgeCmd.config.done')));
  out(dim(t('cli.purgeCmd.config.hint')));
}

export async function purgeAuth(yes: boolean): Promise<void> {
  const paths = getPaths();
  out(dim(t('cli.purgeCmd.auth.warning')));
  if (!(await confirm(t('cli.purgeCmd.auth.confirm'), yes))) {
    out(yellow(t('cli.aborted')));
    return;
  }
  await stopDaemon();
  const backupDir = await backupFiles('auth', [paths.auth]);
  out(dim(t('cli.purgeCmd.backedUpTo', { path: backupDir })));
  await saveAuth(paths.auth, emptyAuth());
  json({ purged: 'auth', backupDir });
  out(green(t('cli.purgeCmd.auth.done')));
  out(dim(t('cli.purgeCmd.auth.hint')));
}
