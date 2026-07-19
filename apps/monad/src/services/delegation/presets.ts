// ACP-agent invite presets, DERIVED from the agent-adapter registry. "Inviting" a same-machine
// third-party agent as an external ACP agent is just the ACP *delivery variant*
// of the same agent-adapter — so the identity (id/label/productIcon) and same-machine install
// detection come from the adapter's detect(), and only the ACP spawn command/env come from its `acp`
// descriptor. One agent, forked by delivery mode; there is no parallel static list to drift.

import type { AcpAgentConfig } from '@monad/environment';
import type { MeshAgentProductIcon, MeshAgentProvider } from '@monad/protocol';

import { type BinProbes, defaultBinProbes } from '#/infra/resolve-binary.ts';
import { findMeshAgentProviderAdapter, listMeshAgentProviderAdapters } from '#/services/mesh-agent/index.ts';

// ACP invites use the vendor's own npx-run bridge package, never the native `codex`/`claude` binary —
// so unlike mesh-agent launch detection (adapter.detect(), which genuinely needs the binary to spawn),
// a login dir alone means the account is set up and auth will just work through it. Scoped to this
// ACP-specific view rather than the shared adapter.detect() result.
/** A vetted ACP-agent invite preset plus the result of probing this machine for the underlying tool.
 *  Shape mirrors the protocol `AcpAgentPresetView`. */
export interface AcpAgentPresetStatus {
  id: string;
  label: string;
  productIcon: MeshAgentProductIcon;
  command: string;
  args: string[];
  env?: Record<string, string>;
  installHint: string;
  installed: boolean;
  resolvedBinPath?: string;
}

/** Every registered agent-adapter that declares an `acp` delivery variant becomes a one-click invite.
 *  Pure read-only (which + existsSync via detect), safe to call often; probes are injectable. */
export function listAcpAgentPresets(probes: BinProbes = defaultBinProbes): AcpAgentPresetStatus[] {
  const presets: AcpAgentPresetStatus[] = [];
  for (const adapter of listMeshAgentProviderAdapters()) {
    if (!adapter.acp) continue;
    const view = adapter.detect(probes);
    const installed = view.installed || (adapter.acp.loginDirectories?.some((path) => probes.exists(path)) ?? false);
    presets.push({
      id: view.id,
      label: view.label,
      productIcon: view.productIcon,
      command: adapter.acp.command,
      args: adapter.acp.args,
      ...(adapter.acp.env ? { env: adapter.acp.env } : {}),
      installHint: view.installHint,
      installed,
      ...(view.resolvedBinPath ? { resolvedBinPath: view.resolvedBinPath } : {})
    });
  }
  return presets;
}

export function productIconForAcpAgent(name: string): MeshAgentProductIcon | undefined {
  const adapter = findMeshAgentProviderAdapter(name as MeshAgentProvider);
  return adapter?.acp ? adapter.productIcon : undefined;
}

/** ACP-capable, installed agent-adapters as ready-to-delegate candidates: an agent that ships an ACP
 *  wrapper (codex/claude-code) and is set up on this machine can be an `agent_acp_delegate` target
 *  WITHOUT the operator hand-configuring it — the built-in adapter's pinned first-party wrapper is
 *  trusted by virtue of being a bundled atom. An operator `cfg.acpAgents` entry of the same name wins. */
export function acpAgentCandidatesFromAdapters(probes: BinProbes = defaultBinProbes): AcpAgentConfig[] {
  return listAcpAgentPresets(probes)
    .filter((preset) => preset.installed)
    .map((preset) => ({
      name: preset.id,
      command: preset.command,
      args: preset.args,
      ...(preset.env ? { env: preset.env } : {}),
      enabled: true,
      osSandbox: false,
      forwardMcp: false
    }));
}
