// Install a registry-style MCP server (npx/uvx stdio, or a remote http url) as a hot file atom under
// atoms/mcp/<name>.json — the same file format connectFileMcpServers reads, carrying the trust block
// (autoApprove + pinnedToolHash). Writing the file (then a rediscovery sweep) connects it live, no
// restart. Distinct from the settings/mcp-server module, which writes config.json (boot-once). consent
// is injected (default-deny) so the orchestrator is testable offline.

import type { InstalledMcpAtom, McpServerView } from '@monad/protocol';

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export class McpInstallError extends Error {}

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

interface McpConsentInfo {
  name: string;
  command?: string;
  url?: string;
  warnings: string[];
}

export interface InstallMcpAtomDeps {
  /** atoms/mcp — the global-tier MCP atom dir (paths.mcp). */
  mcpDir: string;
  /** Default-deny: must return true to proceed. */
  consent: (info: McpConsentInfo) => boolean | Promise<boolean>;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface InstallMcpAtomOutcome {
  name: string;
  needsConsent?: boolean;
  warnings: string[];
}

/** The on-disk file-MCP entry (what connectFileMcpServers reads under `mcpServers[name]`). The file
 *  is an untrusted disk boundary — parsed (not cast) when listing installed atoms. */
const fileMcpEntrySchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  trust: z
    .object({ autoApproveTools: z.array(z.string()).optional(), pinnedToolHash: z.string().optional() })
    .optional()
});
type FileMcpEntry = z.infer<typeof fileMcpEntrySchema>;

const mcpAtomFileSchema = z.object({
  enabled: z.boolean().optional(),
  mcpServers: z.record(z.string(), fileMcpEntrySchema).optional()
});

/** Map a settings-shaped McpServerView onto the on-disk file-MCP entry. http oauth/bearer aren't
 *  supported on the hot file path (no daemon OAuth/secret-prefix there) — those belong in config.json. */
function toFileEntry(server: McpServerView): FileMcpEntry {
  const trust = { autoApproveTools: server.trust.autoApproveTools, pinnedToolHash: server.trust.pinnedToolHash };
  if (server.transport === 'stdio') {
    return { command: server.command, args: server.args, env: server.env, trust };
  }
  if (server.auth.mode === 'bearer' || server.auth.mode === 'oauth') {
    throw new McpInstallError(
      `http ${server.auth.mode} auth isn't supported for a hot atoms/mcp server — add it as a system MCP server (config.json) instead`
    );
  }
  const headers = { ...server.headers, ...(server.auth.mode === 'headers' ? server.auth.headers : {}) };
  return { url: server.url, headers: Object.keys(headers).length ? headers : undefined, trust };
}

export async function installMcpAtom(server: McpServerView, deps: InstallMcpAtomDeps): Promise<InstallMcpAtomOutcome> {
  if (!SAFE_NAME.test(server.name)) throw new McpInstallError(`invalid MCP server name: ${server.name}`);
  const entry = toFileEntry(server); // throws on unsupported auth before any prompt

  const warnings: string[] =
    server.transport === 'stdio'
      ? [`runs \`${[server.command, ...(server.args ?? [])].join(' ')}\` on your machine when the agent uses it`]
      : [`connects to the remote MCP server at ${server.url}`];

  const granted = await deps.consent({
    name: server.name,
    command: server.transport === 'stdio' ? server.command : undefined,
    url: server.transport === 'http' ? server.url : undefined,
    warnings
  });
  if (!granted) return { name: server.name, needsConsent: true, warnings };

  await Bun.write(
    join(deps.mcpDir, `${server.name}.json`),
    `${JSON.stringify({ mcpServers: { [server.name]: entry } }, null, 2)}\n`
  );
  deps.log?.('info', `installed MCP server "${server.name}" (${server.transport})`);
  return { name: server.name, warnings };
}

/** List the installed MCP atoms (one server per atoms/mcp/<name>.json). Hand-dropped multi-server
 *  files are flattened too. */
export async function listInstalledMcpAtoms(mcpDir: string): Promise<InstalledMcpAtom[]> {
  const entries = await readdir(mcpDir, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  const servers: InstalledMcpAtom[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    try {
      const result = mcpAtomFileSchema.safeParse(JSON.parse(await Bun.file(join(mcpDir, e.name)).text()));
      if (!result.success) continue; // malformed mcp atom file — skip
      const parsed = result.data;
      const enabled = parsed.enabled !== false; // absent/true → enabled
      for (const [name, spec] of Object.entries(parsed.mcpServers ?? {})) {
        servers.push({
          name,
          transport: spec.url ? 'http' : 'stdio',
          command: spec.command,
          url: spec.url,
          enabled
        });
      }
    } catch {
      /* malformed file — skip */
    }
  }
  return servers;
}

/** Toggle a file MCP atom on/off by setting a top-level `enabled` flag (connectFileMcpServers skips
 *  a disabled file). The atoms/mcp/<name>.json basename is the operable id. */
export async function setMcpAtomEnabled(mcpDir: string, name: string, enabled: boolean): Promise<void> {
  if (!SAFE_NAME.test(name)) throw new McpInstallError(`invalid MCP server name: ${name}`);
  const file = join(mcpDir, `${name}.json`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await Bun.file(file).text());
  } catch {
    throw new McpInstallError(`MCP server "${name}" not found`);
  }
  await Bun.write(file, `${JSON.stringify({ ...parsed, enabled }, null, 2)}\n`);
}

export async function removeMcpAtom(mcpDir: string, name: string): Promise<void> {
  if (!SAFE_NAME.test(name)) throw new McpInstallError(`invalid MCP server name: ${name}`);
  await rm(join(mcpDir, `${name}.json`), { force: true });
}
