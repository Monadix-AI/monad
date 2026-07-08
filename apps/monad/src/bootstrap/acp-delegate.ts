// Wires the `agent_acp_delegate` tool into the LIVE tool registry (not the boot-time static set) so
// inviting / editing / enabling / disabling / removing an external ACP agent takes effect without a
// daemon restart. Registering (or clearing) the tool bumps registry.toolRevision, which is the agent's
// per-turn memo key — so the fresh roster (and the tool's description) reaches the model on its next
// turn. Same mechanism MCP config servers use (see bootstrap/mcp.ts reloadConfigMcpServers).

import type { AcpAgentConfig, McpServerConfig, MonadAuth } from '@monad/home';
import type { ToolGate } from '#/capabilities/tools/types.ts';
import type { AtomPackRegistry } from '#/handlers/atom-pack/atom-pack-registry.ts';
import type { Store } from '#/store/db/index.ts';

import { createLogger } from '@monad/logger';

import { createAcpDelegateTool, toAcpMcpServers } from '#/services/delegation/acp-delegate.ts';

// Dedicated source tag so clearToolsFrom() drops exactly this tool on a 1→0 transition without
// touching builtin / config-MCP tools (which use the default 'static' source and are never cleared).
const ACP_DELEGATE_SOURCE = 'acp-delegate';

const log = createLogger('acp-delegate');

// Fingerprint of the last-applied state, keyed per registry (so fresh registries in tests are
// independent). configBus fires on EVERY config/profile/auth write (model edits, approvals, hooks, …);
// without this guard each unrelated write would re-resolve all MCP secrets and re-register the tool,
// bumping toolRevision and forcing the model to re-receive its whole roster next turn. The fingerprint
// includes the RESOLVED forwarded servers, so a rotated secret (same config, different resolved value)
// still triggers a re-apply.
const lastFingerprint = new WeakMap<AtomPackRegistry, string>();

export interface ApplyAcpDelegateDeps {
  registry: AtomPackRegistry;
  agents: AcpAgentConfig[];
  /** ACP-capable installed agent-adapters offered as delegable without hand-config (the caller resolves
   *  these from the adapter registry via acpAgentCandidatesFromAdapters). Merged with `agents`; a config
   *  entry of the same name wins. Defaults to none, so tests/callers that don't want them stay hermetic
   *  (no dependency on the machine's installed tools). */
  adapterCandidates?: AcpAgentConfig[];
  /** Oversight gate the sub-agent's permission requests route through (stable across reloads). */
  gate?: ToolGate;
  /** monad's configured MCP servers — forwarded so the delegated sub-agent shares the same tools. */
  mcpServers?: McpServerConfig[];
  /** Auth for resolving MCP env/header secret refs at forward time. */
  auth?: MonadAuth;
  /** Persistence store — passed through to createAcpDelegateTool so delegate lifecycle is recorded. */
  store?: Store;
}

/**
 * (Re)apply the delegate tool from the current acpAgents config. Call once at boot and again on every
 * configBus publish. With zero ENABLED agents the tool is cleared (an empty roster would advertise
 * nothing); otherwise it is (re)registered, overwriting any prior build so the description reflects the
 * current roster — and so the forwarded MCP server set reflects the current config.
 */
export function applyAcpDelegateTool({
  registry,
  agents,
  adapterCandidates,
  gate,
  mcpServers,
  auth,
  store
}: ApplyAcpDelegateDeps): void {
  // Roster = operator-configured agents ∪ ACP-capable, installed agent-adapters (first-party agents that
  // ship a pinned ACP wrapper are delegable without hand-config). A config entry overrides an adapter
  // candidate of the same name, so the operator can still customize (env/sandbox/disable) a built-in.
  const configuredNames = new Set(agents.map((a) => a.name));
  const merged = [...agents, ...(adapterCandidates ?? []).filter((c) => !configuredNames.has(c.name))];
  const enabled = merged.filter((a) => a.enabled);
  if (enabled.length === 0) {
    const fp = 'cleared';
    if (lastFingerprint.get(registry) === fp) return; // already cleared — nothing to do
    const before = registry.toolRevision;
    registry.clearToolsFrom(ACP_DELEGATE_SOURCE);
    lastFingerprint.set(registry, fp);
    if (registry.toolRevision !== before) log.info('acp-delegate tool removed (no enabled external agents)');
    return;
  }
  // `mcpServers` is the raw config.json MCP list. Browser/computer PRESET MCP servers (added by
  // bootstrap/mcp.ts's resolveConfigMcpSpecs) are deliberately NOT here: they grant host control and
  // are not "shared tools" to hand to a third-party adapter.
  const forwarded = toAcpMcpServers(mcpServers ?? [], auth);
  // Skip the re-register when nothing the tool depends on changed (see lastFingerprint).
  const fp = JSON.stringify({ agents: enabled, forwarded });
  if (lastFingerprint.get(registry) === fp) return;
  registry.registerTool(
    createAcpDelegateTool({ agents: merged, gate, mcpServers: forwarded, store }),
    ACP_DELEGATE_SOURCE
  );
  lastFingerprint.set(registry, fp);
  log.info(
    { agents: enabled.map((a) => a.name), mcpServers: forwarded.map((s) => s.name) },
    'acp-delegate tool applied (live)'
  );
}
