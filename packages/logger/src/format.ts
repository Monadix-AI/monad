// Pure, platform-agnostic log-line formatting (ANSI colouring + transport-call rendering). No
// platform APIs — safe in any bundle. The node sink uses this for pretty dev output; it is also
// exported publicly (e.g. transports render their own call summaries with formatTransportCall).

type LogRecord = Record<string, unknown>;
type PrettyRecord = LogRecord & {
  durationMs?: unknown;
  err?: unknown;
  error?: unknown;
  method?: unknown;
  msg?: unknown;
  name?: unknown;
  path?: unknown;
  status?: unknown;
  transport?: unknown;
};

const reset = '\x1B[0m';

// Call sites hand the coloured result to the logger as `msg`, so the escape codes travel with the
// record to EVERY sink — the pretty console renders them, but a JSON sink (production stdout,
// daemon.log, a configured non-pretty console) writes them verbatim into the `msg` string. Only the
// pretty path can consume colour, and pretty output is dev-only, so paint nothing in production or
// under NO_COLOR.
export function isLogColorEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!env) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return env.NODE_ENV !== 'production';
}

const paint = (code: string) => (s: string) => (isLogColorEnabled() ? `\x1B[${code}m${s}${reset}` : s);
const dim = paint('2');
const cyan = paint('36');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const magenta = paint('35');
const bold = paint('1');

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI escape is the point.
const ANSI_PATTERN = /\x1B\[[0-9;]*m/g;

export function stripAnsi(value: string): string {
  return value.includes('\x1B') ? value.replace(ANSI_PATTERN, '') : value;
}

export function formatPrettyMessage(record: PrettyRecord): string {
  const transport = transportName(record);
  if (!transport) {
    const name = typeof record.name === 'string' && record.name.length > 0 ? `${dim(`[${record.name}]`)} ` : '';
    return `${name}${String(record.msg ?? '')}`;
  }

  return `${dim(`[transport:${transport}]`)} ${formatTransportCall(record)}`;
}

export function formatTransportCall(record: PrettyRecord): string {
  const method = typeof record.method === 'string' ? record.method : String(record.method ?? 'call');
  const duration = typeof record.durationMs === 'number' ? ` ${dim('in')} ${magenta(`${record.durationMs}ms`)}` : '';
  if (typeof record.status === 'number' || typeof record.path === 'string') {
    const status = typeof record.status === 'number' ? ` ${statusColor(record.status)(String(record.status))}` : '';
    const path = typeof record.path === 'string' ? ` ${cyan(record.path)}` : '';
    return `${bold(method)}${status}${path}${duration}`;
  }
  const state = record.err || record.error ? red('error') : green('ok');
  return `${cyan(method)} ${state}${duration}`;
}

function transportName(record: PrettyRecord): string | undefined {
  if (typeof record.transport === 'string' && record.transport.length > 0) return record.transport;
  if (typeof record.name === 'string' && record.name.startsWith('transport:'))
    return record.name.slice('transport:'.length);
  return undefined;
}

function statusColor(status: number): (s: string) => string {
  if (status >= 500) return red;
  if (status >= 400) return yellow;
  if (status >= 300) return cyan;
  if (status >= 200) return green;
  return magenta;
}
