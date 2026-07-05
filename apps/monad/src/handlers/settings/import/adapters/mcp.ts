import type { McpServerConfig } from '@monad/home';

import { asBoolean, asRecordArray, asString, asStringArray, isRecord } from './shared.ts';

export function envValue(value: string): string {
  const match = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (match) return value;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? `\${env:${value}}` : value;
}

export function mcpFromRecord(name: string, raw: unknown): McpServerConfig | null {
  if (!isRecord(raw)) return null;
  const transport = asString(raw.transport);
  const command = asString(raw.command);
  const args = asStringArray(raw.args);
  const env = isRecord(raw.env)
    ? (Object.fromEntries(Object.entries(raw.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>)
    : undefined;
  const url = asString(raw.url) ?? asString(raw.serverUrl) ?? asString(raw.endpoint);
  const headers = isRecord(raw.headers)
    ? (Object.fromEntries(Object.entries(raw.headers).filter(([, v]) => typeof v === 'string')) as Record<
        string,
        string
      >)
    : undefined;
  const enabled = asBoolean(raw.enabled) ?? (asBoolean(raw.disabled) === undefined ? true : !asBoolean(raw.disabled));
  const autoApprove =
    asStringArray(raw.autoApprove) ?? asStringArray(raw.allowedTools) ?? asStringArray(raw.autoApproveTools) ?? [];
  const requestTimeoutMs =
    typeof raw.requestTimeoutMs === 'number'
      ? raw.requestTimeoutMs
      : typeof raw.timeout === 'number'
        ? raw.timeout
        : undefined;
  if (url || transport === 'sse' || transport === 'http') {
    if (!url) return null;
    return {
      name,
      transport: 'http',
      url,
      auth: headers ? { mode: 'headers', headers } : { mode: 'none' },
      ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
      enabled,
      trust: { autoApproveTools: autoApprove, hostEscape: false }
    };
  }
  if (!command) return null;
  return {
    name,
    transport: 'stdio',
    command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(asString(raw.cwd) ? { cwd: asString(raw.cwd) } : {}),
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    enabled,
    trust: { autoApproveTools: autoApprove, hostEscape: false }
  };
}

export function mcpEntries(raw: unknown): Array<[string, unknown]> {
  if (isRecord(raw)) return Object.entries(raw);
  const list = asRecordArray(raw);
  if (!list) return [];
  return list.flatMap((entry, index): Array<[string, unknown]> => {
    const name = asString(entry.name) ?? asString(entry.id) ?? `server-${index + 1}`;
    return [[name, entry]];
  });
}
