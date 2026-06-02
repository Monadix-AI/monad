// Playwright MCP requires a real browser binary — without it the first browser.* tool call
// fails with an unhelpful error. Detects the cache and offers `npx playwright install chromium`
// during `monad init` when the browser preset is enabled. Never hard-blocks.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { t } from './i18n.ts';
import { bold, dim, green, out, red, yellow } from './output.ts';

export function playwrightCacheDir(): string {
  if (Bun.env.PLAYWRIGHT_BROWSERS_PATH) return Bun.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') {
    return join(Bun.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright');
  }
  return join(Bun.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright');
}

export function hasChromium(): boolean {
  try {
    const dir = playwrightCacheDir();
    return existsSync(dir) && readdirSync(dir).some((entry) => entry.startsWith('chromium'));
  } catch {
    return false;
  }
}

async function installChromium(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['npx', 'playwright', 'install', 'chromium'], { stdout: 'inherit', stderr: 'inherit' });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function ensureBrowserBinary(ask: (question: string) => Promise<string>): Promise<void> {
  out(`\n${bold(t('cli.browser.header'))} — ${t('cli.browser.playwright')}`);
  if (hasChromium()) {
    out(green(t('cli.browser.found')));
    return;
  }

  out(yellow(t('cli.browser.notFound')));
  const ans = await ask(t('cli.browser.installPrompt'));
  if (/^n$/i.test(ans.trim())) {
    out(dim(t('cli.browser.skipped')));
    return;
  }

  out(dim(t('cli.browser.installing')));
  if (await installChromium()) {
    out(green(t('cli.browser.installed')));
  } else {
    out(red(t('cli.browser.installFailed')));
  }
}
