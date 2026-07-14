// Boot phase: connect every configured (and preset) MCP server and register its tools into the
// shared registry, so a remote tool flows through the same gate + sandbox seam as a built-in. Each
// server is independent and non-fatal — a failed handshake is logged and skipped, never blocking
// startup (mirrors provider/skill discovery). MCP tools are high-risk by construction, so every
// call still routes through the oversight gate.

import type { McpServerConfig, MonadAuth, MonadConfig, MonadPaths } from '@monad/home';
import type { McpServerStatus } from '@monad/protocol';
import type { AtomPackRegistry } from '#/handlers/atom-pack/index.ts';

import { lookup } from 'node:dns/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { matchEnvRef, matchSecretRef } from '@monad/home';
import { logger } from '@monad/logger';

import { HOST_CONTROL_KEY } from '#/agent/approvals/engine.ts';
import { createDaemonMcpOAuth } from '#/capabilities/mcp/oauth.ts';
import { assertUrlAllowed, connectMcpServer, isBlockedIp, type McpConnection } from '#/capabilities/tools';
import { buildBrowserMcpServer, buildComputerMcpServer, buildMonadixMcpServer } from '#/config/mcp-presets.ts';
import { resolveSecretMap, resolveSecretRef } from '#/config/secrets.ts';

/** One live config/preset MCP connection plus the spec it was opened from (the spec lets a later
 *  reload tell "unchanged" from "edited" without re-handshaking). */
export type ConfigMcpEntry = { spec: McpServerConfig; conn: McpConnection };

/** Live config.json + preset MCP connections keyed by server name, plus the set of normalized http
 *  URLs they occupy (seeds file-MCP dedup). main.ts holds this so a settings edit can diff-reconnect
 *  rather than restart. */
export type ConfigMcpHandle = { seenHttp: Set<string>; connections: Map<string, ConfigMcpEntry> };

/** Per-server registry source tag, so a diff reload drops exactly one server's tools via
 *  `clearToolsFrom` (granular, unlike the shared 'file-mcp' tag). */
const configMcpSource = (name: string): string => `config-mcp:${name}`;

/** config.json servers + synthesized browser/computer presets. An operator-defined entry of the same
 *  name wins, so its preset is skipped. */
export function resolveConfigMcpSpecs(cfg: MonadConfig): McpServerConfig[] {
  const mcpServers = [...cfg.mcpServers];
  if (cfg.browser.enabled && !mcpServers.some((s) => s.name === 'browser')) {
    mcpServers.push(buildBrowserMcpServer(cfg.browser));
  }
  if (cfg.computer.enabled && !mcpServers.some((s) => s.name === 'computer')) {
    mcpServers.push(buildComputerMcpServer(cfg.computer));
  }
  if (cfg.monadix.enabled && !mcpServers.some((s) => s.name === 'monadix')) {
    mcpServers.push(buildMonadixMcpServer(cfg.monadix));
  }
  return mcpServers;
}

/** Open ONE config/preset MCP connection over its transport, resolving `${env:}`/`${secret:}` refs
 *  and attaching the daemon OAuth provider for http oauth/none. `interactive` controls whether a 401
 *  during *this connect* may open the browser: false for boot + diff-reload handshakes (silent —
 *  refresh a stored token or fail closed), true for an explicit Authorize/reconnect. Either way the
 *  auth is armed once the connection is live, so a later agent tool-call 401 re-authorizes. Caller
 *  registers the tools + tracks it. */
async function connectOneMcp(
  spec: McpServerConfig,
  paths: MonadPaths,
  auth: MonadAuth | undefined,
  interactive: boolean
): Promise<McpConnection> {
  if (spec.transport !== 'http') {
    return connectMcpServer({
      name: spec.name,
      command: spec.command,
      args: spec.args,
      env: resolveSecretMap(spec.env, auth),
      cwd: spec.cwd,
      requestTimeoutMs: spec.requestTimeoutMs
    });
  }
  const oauth =
    spec.auth.mode === 'oauth'
      ? createDaemonMcpOAuth({
          serverName: spec.name,
          serverUrl: spec.url,
          authPath: paths.auth,
          clientId: spec.auth.clientId,
          scopes: spec.auth.scopes,
          flow: spec.auth.flow,
          interactive,
          log: (m) => logger.info(m)
        })
      : spec.auth.mode === 'none'
        ? createDaemonMcpOAuth({
            serverName: spec.name,
            serverUrl: spec.url,
            authPath: paths.auth,
            interactive,
            log: (m) => logger.info(m)
          })
        : undefined;
  const conn = await connectMcpServer({
    name: spec.name,
    transport: 'http',
    url: spec.url,
    headers: mcpHttpHeaders(spec, auth),
    auth: oauth,
    requestTimeoutMs: spec.requestTimeoutMs
  });
  // The handshake succeeded; arm so a later mid-session 401 (expired/revoked token during an agent
  // tool-call) re-authorizes even for a connection opened non-interactively at boot.
  oauth?.arm();
  return conn;
}

/** Field-level equality of two MCP specs (identity is the name; this catches an edit that warrants a
 *  reconnect). Bun.deepEquals is key-order-independent, so it holds even if the parsed shape reorders. */
function specEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  return Bun.deepEquals(a, b);
}

/** Connect configured + preset (browser/computer) MCP servers, registering their tools (tagged
 *  `config-mcp:<name>`) into the registry. Returns the live connections + http identities; the caller
 *  owns process-exit cleanup and can diff-reconnect via {@link reloadConfigMcpServers}. */
export async function connectMcpServers(
  cfg: MonadConfig,
  paths: MonadPaths,
  registry: AtomPackRegistry,
  auth?: MonadAuth
): Promise<ConfigMcpHandle> {
  const seenHttp = new Set<string>();
  const connections = new Map<string, ConfigMcpEntry>();
  for (const spec of resolveConfigMcpSpecs(cfg)) {
    if (!spec.enabled) {
      logger.info(`monad: MCP server "${spec.name}" disabled — skipping`);
      continue;
    }
    if (spec.transport === 'http' && seenHttp.has(normalizeMcpUrl(spec.url))) {
      logger.info(
        `monad: MCP server "${spec.name}" duplicates already-connected ${normalizeMcpUrl(spec.url)} — skipping`
      );
      continue;
    }
    try {
      const conn = await connectOneMcp(spec, paths, auth, false); // boot: never pop a browser
      if (!registerMcpTools(conn, spec.trust, registry, spec.name, configMcpSource(spec.name))) {
        await conn.close();
        continue;
      }
      if (spec.transport === 'http') seenHttp.add(normalizeMcpUrl(spec.url));
      connections.set(spec.name, { spec, conn });
      logger.info(
        `monad: MCP server "${spec.name}" connected (${conn.tools.length} tool${conn.tools.length === 1 ? '' : 's'})`
      );
    } catch (err) {
      logger.warn(
        `monad: MCP server "${spec.name}" failed to connect: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return { seenHttp, connections };
}

/**
 * Diff the live config/preset MCP connections against a fresh config: connect ADDED, disconnect
 * REMOVED, reconnect CHANGED — and leave UNCHANGED servers' subprocess/session untouched. Used on a
 * settings hot-reload. A config.json write fires on ANY edit (the watcher keys on filename, so a model
 * change triggers it too), so a blanket close-all-reopen-all would needlessly bounce every server and
 * abort in-flight tool calls; the diff only touches what actually changed. The agent reads tools live
 * from the registry, so re-registered tools reach it on the next turn — no restart.
 */
export async function reloadConfigMcpServers(
  prev: Map<string, ConfigMcpEntry>,
  cfg: MonadConfig,
  paths: MonadPaths,
  registry: AtomPackRegistry,
  auth?: MonadAuth
): Promise<ConfigMcpHandle> {
  const seenHttp = new Set<string>();
  const desired = new Map<string, McpServerConfig>();
  for (const spec of resolveConfigMcpSpecs(cfg)) {
    if (!spec.enabled) continue;
    if (spec.transport === 'http') {
      const key = normalizeMcpUrl(spec.url);
      if (seenHttp.has(key)) continue; // dup url already claimed by an earlier server — skip
      seenHttp.add(key);
    }
    desired.set(spec.name, spec);
  }

  const next = new Map<string, ConfigMcpEntry>();
  // Carry over unchanged servers; tear down removed or edited ones (the connect pass re-opens edits).
  for (const [name, entry] of prev) {
    const want = desired.get(name);
    if (want && specEqual(want, entry.spec)) {
      next.set(name, entry);
      continue;
    }
    registry.clearToolsFrom(configMcpSource(name));
    void entry.conn.close();
    logger.info(`monad: MCP server "${name}" ${want ? 'changed — reconnecting' : 'removed — disconnected'}`);
  }
  // Connect added + edited (anything desired not already carried over).
  for (const [name, spec] of desired) {
    if (next.has(name)) continue;
    try {
      const conn = await connectOneMcp(spec, paths, auth, false); // diff-reload: silent (no browser)
      if (!registerMcpTools(conn, spec.trust, registry, name, configMcpSource(name))) {
        await conn.close();
        continue;
      }
      next.set(name, { spec, conn });
      logger.info(
        `monad: MCP server "${name}" connected (${conn.tools.length} tool${conn.tools.length === 1 ? '' : 's'})`
      );
    } catch (err) {
      logger.warn(`monad: MCP server "${name}" failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { seenHttp, connections: next };
}

/** Force-reconnect a SINGLE config/preset MCP server by name (close + clear its tools + reconnect),
 *  leaving every other connection untouched. Used after an OAuth authorize (the spec is unchanged, so
 *  the content diff wouldn't reconnect) and for a manual "retry" on a failed server. Returns the
 *  updated connection map; a removed/disabled server is left disconnected. */
export async function reconnectOneMcpServer(
  name: string,
  prev: Map<string, ConfigMcpEntry>,
  cfg: MonadConfig,
  paths: MonadPaths,
  registry: AtomPackRegistry,
  auth?: MonadAuth
): Promise<Map<string, ConfigMcpEntry>> {
  const next = new Map(prev);
  const existing = next.get(name);
  if (existing) {
    registry.clearToolsFrom(configMcpSource(name));
    void existing.conn.close();
    next.delete(name);
  }
  const spec = resolveConfigMcpSpecs(cfg).find((s) => s.name === name);
  if (!spec?.enabled) return next; // removed or disabled → leave disconnected
  const conn = await connectOneMcp(spec, paths, auth, true); // explicit reconnect: may open the browser
  if (!registerMcpTools(conn, spec.trust, registry, name, configMcpSource(name))) {
    await conn.close();
    return next;
  }
  next.set(name, { spec, conn });
  logger.info(
    `monad: MCP server "${name}" reconnected (${conn.tools.length} tool${conn.tools.length === 1 ? '' : 's'})`
  );
  return next;
}

/** Derive live connection health for every MCP server the daemon knows: config.json servers +
 *  synthesized presets (connected / disabled / failed), file/pack atoms, and obscura. Pure — reads the
 *  current config + the live connection maps the caller holds; no I/O. Powers the status endpoint. */
export function collectMcpStatus(input: {
  cfg: MonadConfig;
  config: Map<string, ConfigMcpEntry>;
  file: McpConnection[];
  obscura: { connected: boolean; tools: string[] };
}): McpServerStatus[] {
  const out: McpServerStatus[] = [];
  const userDefined = new Set(input.cfg.mcpServers.map((s) => s.name));
  for (const spec of resolveConfigMcpSpecs(input.cfg)) {
    const source = userDefined.has(spec.name) ? 'config' : 'preset';
    if (!spec.enabled) {
      out.push({ name: spec.name, source, transport: spec.transport, state: 'disabled', toolCount: 0, tools: [] });
      continue;
    }
    const conn = input.config.get(spec.name)?.conn;
    out.push({
      name: spec.name,
      source,
      transport: spec.transport,
      state: conn ? 'connected' : 'failed',
      toolCount: conn?.tools.length ?? 0,
      tools: conn?.tools.map((t) => t.name) ?? []
    });
  }
  for (const conn of input.file) {
    out.push({
      name: conn.name,
      source: 'file',
      state: 'connected',
      toolCount: conn.tools.length,
      tools: conn.tools.map((t) => t.name)
    });
  }
  if (input.obscura.connected) {
    out.push({
      name: 'obscura',
      source: 'obscura',
      state: 'connected',
      toolCount: input.obscura.tools.length,
      tools: input.obscura.tools
    });
  }
  return out;
}

type FileMcpSpec = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  // Same trust knobs as a config.json server, so a file/pack-declared MCP is NOT a weaker class:
  // pinnedToolHash (rug-pull guard), autoApproveTools (gate exemptions), hostEscape (desktop class).
  trust?: { autoApproveTools?: string[]; pinnedToolHash?: string; hostEscape?: boolean };
};

/** Normalize a file MCP entry's trust into the full config-shaped block (defaults applied). */
function fileTrust(spec: FileMcpSpec): McpServerConfig['trust'] {
  return {
    autoApproveTools: spec.trust?.autoApproveTools ?? [],
    pinnedToolHash: spec.trust?.pinnedToolHash,
    hostEscape: spec.trust?.hostEscape ?? false
  };
}

/**
 * Resolve a pack-declared MCP spec's headers/env. Unlike operator-authored config, a downloadable
 * pack is untrusted: it must NOT be able to resolve `${secret:}`/`${env:}` references into the
 * headers/env sent to a pack-chosen URL or subprocess — that would let a pack exfiltrate daemon
 * secrets to an attacker endpoint on first connect. Drop any ref'd entries (passing the raw token is
 * the whole exploit) and warn.
 */
function resolvePackSafeMap(
  map: Record<string, string> | undefined,
  source: string,
  name: string
): Record<string, string> | undefined {
  if (!map) return undefined;
  const safe: Record<string, string> = {};
  let dropped = false;
  for (const [k, v] of Object.entries(map)) {
    if (matchEnvRef(v) != null || matchSecretRef(v) != null) {
      dropped = true;
      continue;
    }
    safe[k] = v;
  }
  if (dropped) {
    logger.warn(
      `monad: pack MCP "${name}" (${source}) referenced daemon secrets in headers/env — dropped (packs cannot read daemon secrets)`
    );
  }
  return safe;
}

/**
 * SSRF check for an untrusted (pack-declared) MCP URL. `assertUrlAllowed` only rejects literal
 * loopback/private/link-local hostnames; a pack can dodge it with a public DNS name that resolves to
 * a private/metadata IP (DNS rebinding). Resolve the host and reject if ANY address is blocked, so a
 * `*.nip.io`/attacker-controlled name pointing at 127.0.0.1 or 169.254.169.254 is caught too. Throws
 * (caught per-server by the caller). Best-effort: a TOCTOU sliver remains since connectMcpServer
 * re-resolves, but it closes the trivial public-name-to-private-IP bypass.
 */
async function assertPackUrlAllowed(rawUrl: string): Promise<void> {
  const url = assertUrlAllowed(rawUrl); // scheme + literal-host guard
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  const addrs = await lookup(host, { all: true });
  for (const { address } of addrs) {
    if (isBlockedIp(address)) {
      throw new Error(`blocked host (resolves to private/loopback address ${address}): ${host}`);
    }
  }
}

/**
 * Scan file-based MCP atom configs (user-managed atoms/mcp/*.json and pack-embedded
 * atoms/packs/<pack>/mcp.json), connect each server, and register its tools. Each entry carries the
 * SAME trust block as a config.json server (pin / autoApprove / hostEscape) and resolves
 * `${env:NAME}`/`${secret:NAME}` references via `auth`. http servers are deduped by normalized url —
 * `seedHttp` (the config-driven http identities) is the starting seen-set, so two packs (or a pack
 * and a standalone file) pointing at one remote server collapse to a single connection.
 * Returns the open connections so the caller can close them on rediscovery or exit.
 * Non-fatal per server — a bad file or failed handshake is logged and skipped.
 */
export async function connectFileMcpServers(
  paths: MonadPaths,
  registry: AtomPackRegistry,
  auth?: MonadAuth,
  seedHttp?: Iterable<string>
): Promise<McpConnection[]> {
  // `trusted` files are operator-authored (the user dropped them into ~/.monad/atoms/mcp/); pack
  // files (atoms/packs/<pack>/mcp.json) ship inside a downloadable pack and are untrusted — they get
  // SSRF-validated URLs and may not resolve daemon secrets into request headers/env.
  const mcpFiles: { source: string; filePath: string; trusted: boolean }[] = [];

  try {
    const entries = await readdir(paths.mcp, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.json'))
        mcpFiles.push({ source: e.name.replace(/\.json$/, ''), filePath: join(paths.mcp, e.name), trusted: true });
    }
  } catch {
    /* dir absent */
  }

  try {
    const entries = await readdir(paths.packs, { withFileTypes: true });
    for (const e of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
      mcpFiles.push({ source: e.name, filePath: join(paths.packs, e.name, 'mcp.json'), trusted: false });
  } catch {
    /* dir absent */
  }

  const seenHttp = new Set<string>(seedHttp ?? []);
  const connections: McpConnection[] = [];
  for (const { source, filePath, trusted } of mcpFiles) {
    let parsed: { enabled?: boolean; mcpServers?: Record<string, FileMcpSpec> };
    try {
      parsed = JSON.parse(await Bun.file(filePath).text());
    } catch {
      continue; // file missing or malformed — skip silently
    }
    if (parsed.enabled === false) continue; // operator-disabled file MCP atom — skip its servers
    for (const [name, spec] of Object.entries(parsed.mcpServers ?? {})) {
      try {
        if (!spec.url && !spec.command) {
          logger.warn(`monad: file MCP "${name}" (${source}) has neither url nor command — skipping`);
          continue;
        }
        if (spec.url && seenHttp.has(normalizeMcpUrl(spec.url))) {
          logger.info(
            `monad: file MCP "${name}" (${source}) duplicates already-connected ${normalizeMcpUrl(spec.url)} — skipping`
          );
          continue;
        }
        // SSRF guard for untrusted pack URLs: reject loopback/private/link-local/metadata + non-http(s)
        // before connecting, including public names that DNS-resolve to a private IP. Operator-authored
        // atoms/mcp/*.json keep full trust (a local 127.0.0.1 MCP server is a legitimate operator setup).
        if (!trusted && spec.url) await assertPackUrlAllowed(spec.url);
        const conn = spec.url
          ? await connectMcpServer({
              name,
              transport: 'http',
              url: spec.url,
              headers: trusted ? resolveSecretMap(spec.headers, auth) : resolvePackSafeMap(spec.headers, source, name)
            })
          : await connectMcpServer({
              name,
              command: spec.command as string,
              args: spec.args,
              env: trusted ? resolveSecretMap(spec.env, auth) : resolvePackSafeMap(spec.env, source, name)
            });
        if (!registerMcpTools(conn, fileTrust(spec), registry, name, 'file-mcp')) {
          await conn.close();
          continue;
        }
        if (spec.url) seenHttp.add(normalizeMcpUrl(spec.url));
        connections.push(conn);
        logger.info(
          `monad: file MCP "${name}" (${source}) connected — ${conn.tools.length} tool${conn.tools.length === 1 ? '' : 's'}`
        );
      } catch (err) {
        logger.warn(
          `monad: file MCP "${name}" (${source}) failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  return connections;
}

/**
 * Build the HTTP headers for a streamable-http MCP server from its auth config, resolving
 * `${env:NAME}` and `${secret:NAME}` references so tokens never sit in config.json. oauth is
 * filtered out before this is reached.
 */
// Exported for reuse by the acp-delegate MCP forwarder (oauth is filtered out before this is reached).
export function mcpHttpHeaders(
  spec: Extract<McpServerConfig, { transport: 'http' }>,
  auth?: MonadAuth
): Record<string, string> {
  const base = resolveSecretMap(spec.headers, auth) ?? {};
  if (spec.auth.mode === 'bearer')
    return { ...base, authorization: `Bearer ${resolveSecretRef(spec.auth.token, auth)}` };
  if (spec.auth.mode === 'headers') return { ...base, ...resolveSecretMap(spec.auth.headers, auth) };
  return base; // 'none'
}

/**
 * Stable identity for an http MCP server, so the SAME remote declared by two packs (or a pack and a
 * standalone file) collapses to one connection. Trailing-slash-insensitive (`/mcp` == `/mcp/`) but
 * path/query SENSITIVE (`/` != `/mcp`); scheme/host lowercased; default ports elided. Falls back to
 * the trimmed raw string for an unparseable url so a malformed entry still dedups against itself.
 */
function normalizeMcpUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.toString();
  } catch {
    return raw.trim();
  }
}

/**
 * Shared post-connect handling for BOTH config-driven and file/pack-driven MCP: tool-set pin guard
 * (rug-pull) + autoApprove-entry integrity warnings + hostEscape tagging, then register every tool
 * into the registry. Returns false (caller closes the connection) when a pinned tool set no longer
 * matches — so a server that silently changed its tools after vetting is refused.
 */
function registerMcpTools(
  conn: McpConnection,
  trust: McpServerConfig['trust'],
  registry: AtomPackRegistry,
  label: string,
  source: string
): boolean {
  const hash = fingerprintToolset(conn.tools);
  if (trust.pinnedToolHash && trust.pinnedToolHash !== hash) {
    logger.warn(
      `monad: MCP server "${label}" tool set changed (pinned ${trust.pinnedToolHash.slice(0, 12)}… ≠ ${hash.slice(0, 12)}…) — refusing to register. Re-pin trust.pinnedToolHash to accept.`
    );
    return false;
  }
  if (!trust.pinnedToolHash) {
    logger.info(`monad: MCP server "${label}" unpinned — set trust.pinnedToolHash="${hash}" to lock this tool set`);
  }

  // Integrity check for autoApproveTools: an entry that matches no advertised tool is inert (it'll
  // never exempt anything). Catches the `<server>.<tool>` vs `<server>__<tool>` format trap, typos,
  // and a server dropping a tool after vetting. Fail-safe: a stale entry only OVER-gates, so warn.
  const advertised = new Set(conn.tools.map((t) => t.name));
  for (const approved of trust.autoApproveTools) {
    if (!advertised.has(approved)) {
      logger.warn(
        `monad: MCP server "${label}" autoApproveTools entry "${approved}" matches no advertised tool — it has no effect. Tool names are "<server>__<tool>". Advertised: ${[...advertised].join(', ')}`
      );
    }
  }

  const tools = conn.tools.map((t) => {
    if (trust.autoApproveTools.includes(t.name)) return { ...t, highRisk: false };
    // Host-escape server (computer-use): its non-read-only tools drive the user's real desktop. Tag
    // them with the host-control gate key so the approval engine treats them as ONE session-grantable
    // class ("control this computer for this session") that can never persist as a global/agent allow.
    if (trust.hostEscape) return { ...t, gateKey: () => HOST_CONTROL_KEY };
    return t;
  });
  for (const t of tools) registry.registerTool(t, source, label);
  return true;
}

/**
 * Stable SHA-256 over an MCP server's advertised tools (name + description), order-
 * independent. Used to pin a vetted tool set so a server can't silently change tool
 * behaviour after the operator approved it (rug-pull / supply-chain guard).
 */
export function fingerprintToolset(tools: { name: string; description: string }[]): string {
  const sig = tools
    .map((t) => `${t.name}::${t.description}`)
    .sort()
    .join('\n');
  const h = new Bun.CryptoHasher('sha256');
  h.update(sig);
  return h.digest('hex');
}
