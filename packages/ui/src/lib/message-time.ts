const formatterCache = new Map<string, Intl.DateTimeFormat>();
const relativeFormatterCache = new Map<string, Intl.RelativeTimeFormat>();

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat(locale, options);
  formatterCache.set(key, created);
  return created;
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function relativeFormatter(locale: string): Intl.RelativeTimeFormat {
  const cached = relativeFormatterCache.get(locale);
  if (cached) return cached;
  const created = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  relativeFormatterCache.set(locale, created);
  return created;
}

export function formatMessageTimestamp(iso: string | undefined, locale: string, now: Date = new Date()): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);
  const time = formatter(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
  if (sameCalendarDay(at, now)) return time;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameCalendarDay(at, yesterday)) return `${relativeFormatter(locale).format(-1, 'day')} ${time}`;
  const date = formatter(locale, {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  }).format(at);
  return `${date} ${time}`;
}
