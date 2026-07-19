import type { MeshAgentProvider, MeshAgentSettingsImportItem } from '@monad/protocol';

import { previewItem } from './settings-import-items.ts';
import { asString, asStringArray, getPath, isRecord } from './settings-import-parse.ts';

function mcpEnv(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, string] => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) && typeof entry[1] === 'string'
  );
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
    const env = mcpEnv(raw.env);
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
  items: MeshAgentSettingsImportItem[],
  sourcePath: string,
  data: Record<string, unknown>,
  provider: MeshAgentProvider
): void {
  const servers =
    getPath(data, ['mcp_servers']) ?? getPath(data, ['mcpServers']) ?? getPath(data, ['mcp', 'servers']) ?? {};
  for (const [name, raw] of mcpEntries(servers)) {
    const mapped = mcpPayload(name, raw);
    items.push(
      previewItem(
        'mcpServers',
        `${sourcePath}:mcp.${name}`,
        name,
        mapped ? `${provider} MCP server maps to Monad mcpServers` : `Unsupported ${provider} MCP shape`,
        mapped?.payload ?? { kind: 'manual' },
        {
          action: mapped ? 'add' : 'manual',
          risk: mapped && isRecord(raw) && !asString(raw.command) ? 'low' : 'medium',
          summary: mapped?.summary
        }
      )
    );
  }
}
