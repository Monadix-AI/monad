export const enMessages: Record<string, string> = {};
export const zhMessages: Record<string, string> = {};

export function builtinMessagesForLocale(locale: string): Record<string, string> {
  return locale === 'zh' ? zhMessages : enMessages;
}

export function buildBuiltinCatalog(locale: string, fallback = 'en'): Record<string, string> {
  const active = builtinMessagesForLocale(locale);
  const fb = builtinMessagesForLocale(fallback);
  return active === fb ? active : { ...fb, ...active };
}
