const STRUCTURAL_STRING_KEYS = new Set([
  'coverage',
  'event',
  'kind',
  'level',
  'method',
  'name',
  'op',
  'origin',
  'overageStatus',
  'overage_status',
  'phase',
  'provider',
  'rateLimitType',
  'rate_limit_type',
  'role',
  'state',
  'status',
  'stop_reason',
  'stream',
  'subtype',
  'type'
]);

export const SANITIZED_TIMESTAMP_BASE = Date.parse('2000-01-01T00:00:00.000Z');

const PLACEHOLDER = /^<(?:id|path|secret|text):\d+>$/;
const SANITIZED_TIMESTAMP = /^2000-01-01T00:0\d:\d{2}\.\d{3}Z$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?$/;
const SECRET_KEY = /(?:token|api[_-]?key|secret|password|passwd|authorization|credential|bearer|cookie)/i;
const SECRET_VALUE = /(?:^(?:sk|pk|rk)-|^gh[pousr]_|^xox[abposr]-|^ey[A-Za-z0-9_-]{20,}\.|^ABSK)/;
const PATH_KEY = /(?:^|_|\b)(?:path|dir|directory|cwd|file|filename|root|workdir)s?$/i;
const PATH_VALUE = /^(?:~?\/[^\s]*|[A-Za-z]:[\\/][^\s]*|file:\/\/)/;
const ID_KEY = /(?:^|_)(?:id|ids|uuid|ref|hash|sha)$|Id$|Ids$|Ref$|Uuid$/;
const ID_VALUE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26}|[a-z]{3,4}_[0-9A-Za-z]{6,}|[0-9a-f]{32,64})$/;

export type SanitizedKind = 'id' | 'path' | 'secret' | 'text';

function classify(key: string, value: string): SanitizedKind {
  if (SECRET_KEY.test(key) || SECRET_VALUE.test(value)) return 'secret';
  if (PATH_KEY.test(key) || PATH_VALUE.test(value)) return 'path';
  if (ID_KEY.test(key) || ID_VALUE.test(value)) return 'id';
  return 'text';
}

/**
 * Placeholders are assigned per distinct source value and shared across kinds, so a value that
 * appears both as an id and as free text keeps one identity across the whole fixture — otherwise
 * a projector that correlates a tool call with its output would see two unrelated strings and the
 * fixture would stop exercising the correlation it was captured for.
 */
export class ObservationSanitizer {
  private readonly assigned = new Map<string, string>();
  private readonly counters = new Map<SanitizedKind, number>();
  private readonly timestamps = new Map<string, string>();

  /**
   * Distinct source timestamps map to distinct, monotonically increasing sanitized instants rather
   * than one frozen value: projectors order and correlate frames by time, so collapsing every
   * timestamp would silently turn an ordered capture into a simultaneous one.
   */
  private normalizeTimestamp(value: string): string {
    const existing = this.timestamps.get(value);
    if (existing) return existing;
    const next = new Date(SANITIZED_TIMESTAMP_BASE + this.timestamps.size + 1).toISOString();
    this.timestamps.set(value, next);
    return next;
  }

  private placeholder(key: string, value: string): string {
    const existing = this.assigned.get(value);
    if (existing) return existing;
    const kind = classify(key, value);
    const next = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, next);
    const token = `<${kind}:${next}>`;
    this.assigned.set(value, token);
    return token;
  }

  sanitize(value: unknown, key = ''): unknown {
    if (typeof value === 'string') {
      if (STRUCTURAL_STRING_KEYS.has(key)) return value;
      if (PLACEHOLDER.test(value)) return value;
      if (SANITIZED_TIMESTAMP.test(value)) return value;
      if (ISO_TIMESTAMP.test(value)) return this.normalizeTimestamp(value);
      return this.placeholder(key, value);
    }
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item, key));
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        this.sanitize(child, childKey)
      ])
    );
  }
}

export function sanitizeObservationRecords(records: readonly unknown[]): unknown[] {
  const sanitizer = new ObservationSanitizer();
  return records.map((record) => sanitizer.sanitize(record));
}

export function unsanitizedSemanticStrings(value: unknown, key = '', path = '$'): string[] {
  if (typeof value === 'string') {
    if (STRUCTURAL_STRING_KEYS.has(key)) return [];
    if (PLACEHOLDER.test(value)) return [];
    if (SANITIZED_TIMESTAMP.test(value)) return [];
    return [`${path}=${value}`];
  }
  if (Array.isArray(value))
    return value.flatMap((item, index) => unsanitizedSemanticStrings(item, key, `${path}[${index}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([childKey, child]) =>
    unsanitizedSemanticStrings(child, childKey, `${path}.${childKey}`)
  );
}
