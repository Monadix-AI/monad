// A compact, zero-dependency evaluator for standard 5-field cron expressions
// (minute hour day-of-month month day-of-week). Supports `*`, lists (`1,2,3`),
// ranges (`1-5`), and steps (`*/5`, `1-10/2`).
//
// Day-of-week is 0–6 (0 = Sunday); 7 is also accepted as Sunday. When BOTH day-of-month and
// day-of-week are restricted, a day matches if EITHER does — the Vixie-cron convention.

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

function parseField(spec: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [rangePart = '', stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step <= 0) throw new CronError(`invalid step in ${label}: "${part}"`);

    let lo: number;
    let hi: number;
    if (rangePart === '*' || rangePart === '') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number.parseInt(a ?? '', 10);
      hi = Number.parseInt(b ?? '', 10);
    } else {
      lo = Number.parseInt(rangePart, 10);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new CronError(`${label} out of range (${min}-${max}): "${part}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse a 5-field cron expression. Throws CronError on malformed input. */
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(`cron expression must have 5 fields, got ${parts.length}: "${expr}"`);
  const [m, h, dom, mon, dowRaw] = parts as [string, string, string, string, string];

  const dow = parseField(dowRaw, 0, 7, 'day-of-week');
  if (dow.delete(7)) dow.add(0); // normalize 7 → Sunday

  return {
    minute: parseField(m, 0, 59, 'minute'),
    hour: parseField(h, 0, 23, 'hour'),
    dom: parseField(dom, 1, 31, 'day-of-month'),
    month: parseField(mon, 1, 12, 'month'),
    dow,
    domRestricted: dom !== '*',
    dowRestricted: dowRaw !== '*'
  };
}

function dayMatches(fields: CronFields, date: Date): boolean {
  const domOk = fields.dom.has(date.getDate());
  const dowOk = fields.dow.has(date.getDay());
  // Vixie rule: both restricted → OR; otherwise the restricted one (or both `*`) must hold.
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** The next instant strictly after `after` that matches `fields`, scanning minute-by-minute
 * in local time. Returns null if nothing matches within ~4 years (an impossible expression
 * like Feb-30). Seconds/millis are zeroed — cron has minute granularity. */
export function nextCronTime(fields: CronFields, after: Date): Date | null {
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after `after`

  const limit = new Date(after.getTime());
  limit.setFullYear(limit.getFullYear() + 4);

  while (d.getTime() <= limit.getTime()) {
    if (!fields.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(fields, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!fields.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  return null;
}
