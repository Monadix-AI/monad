import type { CommandDef } from './types.ts';

import { cp, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MonadClient } from '@monad/client';
import { emptyAuth, getPaths, initMonadHome, loadAll, resolveClientConn, saveAuth } from '@monad/home';

import { stopDaemon } from '../lib/daemon.ts';
import { t } from '../lib/i18n.ts';
import { ask } from '../lib/init-flow.ts';
import { bold, dim, green, out, red, yellow } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';

const SUBCOMMANDS = ['sessions', 'config', 'auth', 'usage', 'all'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

async function confirm(message: string, skipConfirm: boolean): Promise<boolean> {
  if (skipConfirm) return true;
  const ans = await ask(`${message} [y/N] `);
  return /^y$/i.test(ans);
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
  const backupDir = join(paths.backup, `reset-${label}-${stamp}`);
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

export const command: CommandDef = {
  local: true,
  name: 'reset',
  synopsis: 'reset <sessions|config|auth|usage|all> [--keep-last <n>]',
  description: 'selectively reset parts of the monad system',
  descriptionKey: 'cli.cmd.reset.desc',
  flags: {
    'keep-last': {
      type: 'number',
      description: 'for "sessions": keep this many most-recent sessions',
      descriptionKey: 'cli.cmd.reset.keepLastFlag'
    }
  },
  async run({ positionals, flags, globals }) {
    const sub = positionals[0] as Subcommand | undefined;

    if (!sub || !SUBCOMMANDS.includes(sub as Subcommand)) {
      out(`${t('cli.subcommands')}`);
      for (const s of SUBCOMMANDS) out(dim(`  monad reset ${s}`));
      return;
    }

    const paths = getPaths();

    if (sub === 'all') {
      if (!globals.yes) {
        out(`${red(bold('WARNING'))}  ${t('cli.reset.warning')}`);
        out(dim(`  ${paths.home}`));
        out(dim(t('cli.reset.lost')));
        out('');
        const first = await ask(t('cli.reset.confirm1'));
        if (first !== 'reset') {
          out(yellow(t('cli.aborted')));
          return;
        }
        const second = await ask(t('cli.reset.confirm2'));
        if (!/^y$/i.test(second)) {
          out(yellow(t('cli.aborted')));
          return;
        }
      }
      await stopDaemon();
      const { rm } = await import('node:fs/promises');
      await rm(paths.home, { recursive: true, force: true });
      const result = await initMonadHome(paths);
      out(green(t('cli.reset.done')) + dim(` (principal: ${result.principalId})`));
      out(dim(t('cli.reset.restartHint')));
      return;
    }

    if (sub === 'sessions') {
      const keepLast = (flags['keep-last'] as number | undefined) ?? 0;
      if (keepLast > 0) {
        out(dim(t('cli.resetCmd.sessions.keepWarning', { n: keepLast })));
      } else {
        out(dim(t('cli.resetCmd.sessions.warning')));
      }
      if (!(await confirm(t('cli.resetCmd.sessions.confirm'), globals.yes))) {
        out(yellow(t('cli.aborted')));
        return;
      }

      if (keepLast > 0) {
        // Operate directly on the SQLite file — avoids needing a live daemon and is O(1) regardless
        // of session count. The daemon must be stopped first so the WAL is flushed.
        await stopDaemon();
        const backupDir = await backupFiles('sessions', [paths.db]);
        out(dim(t('cli.resetCmd.backedUpTo', { path: backupDir })));
        const { Database } = await import('bun:sqlite');
        const db = new Database(paths.db, { readonly: false });
        try {
          const deleted = db
            .prepare(
              `DELETE FROM sessions WHERE id NOT IN (
                SELECT id FROM sessions ORDER BY created_at DESC LIMIT ?
              )`
            )
            .run(keepLast);
          out(green(t('cli.resetCmd.sessions.deletedN', { n: deleted.changes })));
        } finally {
          db.close();
        }
        out(dim(t('cli.reset.restartHint')));
      } else {
        await stopDaemon();
        const backupDir = await backupFiles('sessions', [paths.db]);
        out(dim(t('cli.resetCmd.backedUpTo', { path: backupDir })));
        await silentUnlink(paths.db);
        out(green(t('cli.resetCmd.sessions.done')));
        out(dim(t('cli.reset.restartHint')));
      }
      return;
    }

    if (sub === 'config') {
      // Show current config summary before wiping
      const existing = await loadAll(paths.config, paths.profile);
      if (existing) {
        out(t('cli.resetCmd.config.current'));
        out(dim(`  principal:  ${existing.principal.displayName} (${existing.principal.id})`));
        out(dim(`  default model: ${existing.model.default || '(none)'}`));
        out(dim(`  providers:  ${existing.model.providers.map((p) => p.label).join(', ') || '(none)'}`));
        out(dim(`  port:  ${existing.network.port}  transport: ${existing.network.transport}`));
        out(dim(`  channels:   ${existing.channels.length}`));
        out('');
      }
      out(dim(t('cli.resetCmd.config.warning')));
      if (!(await confirm(t('cli.resetCmd.config.confirm'), globals.yes))) {
        out(yellow(t('cli.aborted')));
        return;
      }
      await stopDaemon();
      const backupDir = await backupFiles('config', [paths.config, paths.profile]);
      out(dim(t('cli.resetCmd.backedUpTo', { path: backupDir })));
      await Promise.all([silentUnlink(paths.config), silentUnlink(paths.profile)]);
      await initMonadHome(paths);
      out(green(t('cli.resetCmd.config.done')));
      out(dim(t('cli.resetCmd.config.hint')));
      return;
    }

    if (sub === 'auth') {
      out(dim(t('cli.resetCmd.auth.warning')));
      if (!(await confirm(t('cli.resetCmd.auth.confirm'), globals.yes))) {
        out(yellow(t('cli.aborted')));
        return;
      }
      await stopDaemon();
      const backupDir = await backupFiles('auth', [paths.auth]);
      out(dim(t('cli.resetCmd.backedUpTo', { path: backupDir })));
      await saveAuth(paths.auth, emptyAuth());
      out(green(t('cli.resetCmd.auth.done')));
      out(dim(t('cli.resetCmd.auth.hint')));
      return;
    }

    if (sub === 'usage') {
      if (!(await confirm(t('cli.resetCmd.usage.confirm'), globals.yes))) {
        out(yellow(t('cli.aborted')));
        return;
      }
      const { baseUrl, token, unixSocket } = await resolveClientConn();
      const client = new MonadClient({ baseUrl, token: token ?? undefined, unixSocket });
      requireTreatyData(await client.treaty.v1.usage.reset.post());
      out(green(t('cli.usageCmd.reset')));
      return;
    }
  }
};
