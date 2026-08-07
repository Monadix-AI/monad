export interface MessageTimeLabels {
  yesterday: string;
}

// Intl formatters are expensive to construct (~0.1ms) and this runs for every message on every
// transcript render — during streaming, once per token. Constructing them once per (locale, shape)
// turns that into a hash lookup.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

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

/**
 * Renders a message timestamp with day context: today shows the time alone, yesterday is labeled,
 * and anything older carries its date (with the year once it differs from the current one).
 */
export function formatMessageTimestamp(
  iso: string | undefined,
  locale: string,
  labels: MessageTimeLabels,
  now: Date = new Date()
): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);
  const time = formatter(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
  if (sameCalendarDay(at, now)) return time;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameCalendarDay(at, yesterday)) return `${labels.yesterday} ${time}`;
  const date = formatter(locale, {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  }).format(at);
  return `${date} ${time}`;
}
