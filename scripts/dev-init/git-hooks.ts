import { chmod, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const managedPostCheckoutHookMarker = 'monad managed post-checkout bootstrap';

export function postCheckoutHookText(): string {
  return [
    '#!/bin/sh',
    `# ${managedPostCheckoutHookMarker}`,
    'set -u',
    '',
    'root=$(git rev-parse --show-toplevel 2>/dev/null || true)',
    '',
    'if [ -n "$root" ] && [ -x "$root/scripts/git-hooks/post-checkout.sh" ]; then',
    '  "$root/scripts/git-hooks/post-checkout.sh" "$@" || exit $?',
    'fi',
    '',
    'if command -v lefthook >/dev/null 2>&1; then',
    '  lefthook run "post-checkout" "$@"',
    'elif [ -n "$root" ] && [ -x "$root/node_modules/.bin/lefthook" ]; then',
    '  "$root/node_modules/.bin/lefthook" run "post-checkout" "$@"',
    'else',
    '  echo "[monad hook] lefthook not found; skipped post-checkout lefthook jobs" >&2',
    'fi'
  ].join('\n');
}

export async function installPostCheckoutHook(root: string, log: (msg: string) => void, warn: (msg: string) => void) {
  const commonDirText = await Bun.$`git rev-parse --git-common-dir`
    .cwd(root)
    .quiet()
    .text()
    .then((t) => t.trim())
    .catch(() => '');

  if (!commonDirText) {
    warn('git hooks path not found — skipping post-checkout bootstrap install');
    return;
  }

  const commonDir = isAbsolute(commonDirText) ? commonDirText : join(root, commonDirText);
  const hooksDir = join(commonDir, 'hooks');
  const hookPath = join(hooksDir, 'post-checkout');
  const desired = `${postCheckoutHookText()}\n`;
  const current = (await Bun.file(hookPath).exists()) ? await Bun.file(hookPath).text() : '';

  if (current === desired) {
    log('git hook              post-checkout bootstrap already installed');
    return;
  }

  if (current && !current.includes(managedPostCheckoutHookMarker)) {
    log('git hook              replacing post-checkout with monad bootstrap wrapper');
  }

  await mkdir(hooksDir, { recursive: true });
  await Bun.write(hookPath, desired);
  await chmod(hookPath, 0o755);
  log('git hook              post-checkout bootstrap installed');
}
