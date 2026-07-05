import type { NativeCliProvider, NativeCliSettingsImportItem } from '@monad/protocol';

import { previewItem } from './settings-import-items.ts';
import { asString, asStringArray, isRecord, recordAt } from './settings-import-parse.ts';

function secretEnvRefs(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const entries = Object.keys(raw)
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .sort()
    .map((key) => [key, `\${env:${key}}`]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mcpEntries(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index): Array<[string, unknown]> => {
      if (!isRecord(entry)) return [];
      const name = asString(entry.name) ?? asString(entry.id) ?? `server-${index + 1}`;
      return [[name, entry]];
    });
  }
  return isRecord(value) ? Object.entries(value) : [];
}

function mcpPayload(name: string, raw: unknown): { summary?: string; payload: unknown } | null {
  if (!isRecord(raw)) return null;
  const command = asString(raw.command);
  const url = asString(raw.url) ?? asString(raw.endpoint);
  if (command) {
    const args = asStringArray(raw.args) ?? [];
    const env = secretEnvRefs(raw.env);
    return {
      summary: command,
      payload: {
        kind: 'mcpServer',
        server: {
          name,
          transport: 'stdio',
          command,
          args,
          ...(env ? { env } : {}),
          enabled: true
        }
      }
    };
  }
  if (url) {
    return {
      summary: url,
      payload: {
        kind: 'mcpServer',
        server: {
          name,
          transport: 'http',
          url,
          auth: { mode: 'none' },
          enabled: true
        }
      }
    };
  }
  return null;
}

export function addMcpItems(
  items: NativeCliSettingsImportItem[],
  sourcePath: string,
  data: Record<string, unknown>,
  provider: NativeCliProvider
): void {
  const servers =
    recordAt(data, ['mcp_servers']) ?? recordAt(data, ['mcpServers']) ?? recordAt(data, ['mcp', 'servers']) ?? {};
  for (const [name, raw] of mcpEntries(servers)) {
    const mapped = mcpPayload(name, raw);
    items.push(
      previewItem(
        'mcpServers',
        `${sourcePath}:mcp.${name}`,
        name,
        mapped ? `${provider} MCP server maps to monad mcpServers` : `Unsupported ${provider} MCP shape`,
        mapped?.payload ?? { kind: 'manual' },
        {
          action: mapped ? 'add' : 'manual',
          risk: mapped?.summary === 'npx' || mapped?.payload ? 'medium' : 'medium',
          summary: mapped?.summary
        }
      )
    );
  }
}
