import { watch } from 'node:fs';
import { join } from 'node:path';

import { checkCatalog, writeCatalog } from './i18n/catalog';
import { LOCALES_DIR, type ParaglideScope } from './i18n/constants';
import { changedParaglideScopes, generatedFilesMatch } from './i18n/paraglide';
import { pruneI18n } from './i18n/prune';

export { changedParaglideScopes, generatedFilesMatch };

type Mode = 'check' | 'write' | 'write-if-stale' | 'watch' | 'prune' | 'prune-dry-run';

function usage(): never {
  throw new Error('usage: bun run scripts/i18n.ts [--check|--write|--write-if-stale|--watch|prune [--dry-run]]');
}

function parseMode(): Mode {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--check')) return 'check';
  if (args.length === 1 && args[0] === '--write') return 'write';
  if (args.length === 1 && args[0] === '--write-if-stale') return 'write-if-stale';
  if (args.length === 1 && args[0] === '--watch') return 'watch';
  if (args.length === 1 && args[0] === 'prune') return 'prune';
  if (args.length === 2 && args[0] === 'prune' && args[1] === '--dry-run') return 'prune-dry-run';
  return usage();
}

async function watchCatalog() {
  await writeCatalog('write-if-stale');
  process.stdout.write('i18n catalog watcher ready\n');

  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = new Set<string>();
  const schedule = (filename: string | null) => {
    if (filename) changed.add(join(LOCALES_DIR, filename));
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const paths = [...changed];
      changed.clear();
      const scopes: ParaglideScope[] = changedParaglideScopes(paths);
      if (scopes.length === 0) return;
      try {
        await writeCatalog('write-if-stale', scopes);
      } catch (err) {
        process.stderr.write(`i18n catalog update failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }, 200);
  };

  const watcher = watch(LOCALES_DIR, { recursive: true }, (_event, filename) => schedule(filename?.toString() ?? null));
  await new Promise<void>((resolve) => {
    const close = () => {
      watcher.close();
      resolve();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}

async function main() {
  const mode = parseMode();
  if (mode === 'check') await checkCatalog();
  else if (mode === 'watch') await watchCatalog();
  else if (mode === 'prune') await pruneI18n(false);
  else if (mode === 'prune-dry-run') await pruneI18n(true);
  else await writeCatalog(mode);
}

if (import.meta.main) {
  await main();
}
