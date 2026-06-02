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
const dim = (s: string) => `\x1B[2m${s}${reset}`;
const cyan = (s: string) => `\x1B[36m${s}${reset}`;
const green = (s: string) => `\x1B[32m${s}${reset}`;
const yellow = (s: string) => `\x1B[33m${s}${reset}`;
const red = (s: string) => `\x1B[31m${s}${reset}`;
const magenta = (s: string) => `\x1B[35m${s}${reset}`;
const bold = (s: string) => `\x1B[1m${s}${reset}`;

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
