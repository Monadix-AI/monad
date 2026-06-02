import type { MonadPaths } from '@monad/home';
import type { Store } from '@/store/db/index.ts';

import { unlink } from 'node:fs/promises';
import { initMonadHome, loadAll, loadAuth, saveAuth, saveProfile, tryParseProfile } from '@monad/home';

import { CURRENT_SCHEMA_VERSION } from '@/store/db/index.ts';

export interface IntegrityReport {
  config: 'ok' | 'missing';
  profile: 'ok' | 'missing' | 'repaired';
  auth: 'ok' | 'repaired' | 'missing';
  db: 'ok' | 'version-mismatch';
}

/** Run integrity checks and auto-repair where safe. Safe to call on every daemon startup. */
export async function checkAndRepair(paths: MonadPaths, store: Store): Promise<IntegrityReport> {
  const report: IntegrityReport = { config: 'ok', profile: 'ok', auth: 'ok', db: 'ok' };

  // Check profile.json before calling loadAll so corrupt profile is repaired first
  // (loadAll throws on corrupt profile.json, which would mask the config check).
  {
    let profileExists = true;
    try {
      await Bun.file(paths.profile).text();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') profileExists = false;
    }

    if (!profileExists) {
      // loadAll bootstraps profile from config.json in memory but doesn't persist it.
      // Re-load then save explicitly.
      const merged = await loadAll(paths.config, paths.profile).catch(() => null);
      if (merged) await saveProfile(paths.profile, merged);
      report.profile = 'missing';
    } else {
      const parsed = await tryParseProfile(paths.profile);
      if (parsed === null) {
        // Remove corrupt file so loadAll can bootstrap a default profile.
        await unlink(paths.profile).catch(() => {});
        const merged = await loadAll(paths.config, paths.profile).catch(() => null);
        if (merged) await saveProfile(paths.profile, merged);
        report.profile = 'repaired';
      }
    }
  }

  {
    const parsed = await loadAll(paths.config, paths.profile);
    if (parsed === null) {
      await initMonadHome(paths);
      report.config = 'missing';
    } else if (repairDefaultProfile(parsed)) {
      await saveProfile(paths.profile, parsed);
      report.profile = 'repaired';
    }
  }

  {
    let fileExists = true;
    const parsed = await loadAuth(paths.auth).catch(() => null);

    if (parsed === null) {
      // Distinguish missing vs. corrupt to set the right report status.
      try {
        await Bun.file(paths.auth).text();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') fileExists = false;
      }

      await saveAuth(paths.auth, {
        version: 1,
        activeProvider: null,
        updatedAt: new Date().toISOString(),
        credentialPool: {}
      });

      if (!fileExists) {
        report.auth = 'missing';
      } else {
        report.auth = 'repaired';
      }
    }
  }

  {
    const version = store.getSchemaVersion();
    if (version !== CURRENT_SCHEMA_VERSION) {
      report.db = 'version-mismatch';
    }
  }

  return report;
}

function repairDefaultProfile(cfg: Awaited<ReturnType<typeof loadAll>>): boolean {
  if (!cfg || cfg.model.profiles.length === 0) return false;
  if (cfg.model.default && cfg.model.profiles.some((profile) => profile.alias === cfg.model.default)) return false;
  const first = cfg.model.profiles[0];
  if (!first) return false;
  cfg.model.default = first.alias;
  return true;
}
