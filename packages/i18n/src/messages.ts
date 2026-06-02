import enChannel from './locales/en/channel.json';
import enCli from './locales/en/cli.json';
import enCmd from './locales/en/cmd.json';
import enDaemon from './locales/en/daemon.json';
import enInit from './locales/en/init.json';
import enWeb from './locales/en/web.json';
import zhChannel from './locales/zh/channel.json';
import zhCli from './locales/zh/cli.json';
import zhCmd from './locales/zh/cmd.json';
import zhDaemon from './locales/zh/daemon.json';
import zhInit from './locales/zh/init.json';
import zhWeb from './locales/zh/web.json';

export const enMessages: Record<string, string> = {
  ...enChannel,
  ...enCli,
  ...enCmd,
  ...enDaemon,
  ...enInit,
  ...enWeb
};
export const zhMessages: Record<string, string> = {
  ...zhChannel,
  ...zhCli,
  ...zhCmd,
  ...zhDaemon,
  ...zhInit,
  ...zhWeb
};

export function builtinMessagesForLocale(locale: string): Record<string, string> {
  return locale === 'zh' ? zhMessages : enMessages;
}

const builtinCatalogCache = new Map<string, Readonly<Record<string, string>>>();

export function buildBuiltinCatalog(locale: string, fallback = 'en'): Record<string, string> {
  const cacheKey = `${locale}\0${fallback}`;
  const cached = builtinCatalogCache.get(cacheKey);
  if (cached) return cached;

  const active = builtinMessagesForLocale(locale);
  const fb = builtinMessagesForLocale(fallback);
  const out: Record<string, string> = {};
  for (const key of new Set([...Object.keys(fb), ...Object.keys(active)])) {
    out[key] = active[key] ?? fb[key] ?? key;
  }
  const catalog = Object.freeze(out);
  builtinCatalogCache.set(cacheKey, catalog);
  return catalog;
}
