// Turnkey presets for "inviting" a same-machine third-party agent as an external ACP agent. Each
// preset is a ready-made acpAgents entry (command/args/env) plus a same-machine DETECT that tells the
// UI whether the underlying tool looks set up, so the operator can one-click invite Codex / Claude
// Code instead of hand-typing the adapter incantation.
//
// Both adapters are self-contained npm packages (`npx -y …`): claude-agent-acp / codex-acp ship
// a prebuilt bridge that links the agent's own SDK, so they do NOT require the `claude`/`codex` CLI on
// PATH. Detection is therefore only a "you have this tool / you're logged in" SIGNAL — we probe the
// CLI binary (incl. known app-bundle locations, since the Codex.app binary is not on PATH) and the
// login dir. Auth flows through the agent's existing credentials (~/.codex, ~/.claude) or an env key.

import type { NativeCliProductIcon } from '@monad/protocol';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { type BinProbes, defaultBinProbes, resolveBinary } from '@/infra/resolve-binary.ts';

/** The invite template: exactly the fields an acpAgents entry needs (see acpAgentSchema). */
interface AcpAgentPreset {
  id: string; // stable preset key, also the default agent `name`
  label: string; // human label for the UI
  productIcon: NativeCliProductIcon;
  command: string; // e.g. 'npx'
  args: string[]; // e.g. ['-y', '@zed-industries/claude-code-acp']
  env?: Record<string, string>; // optional auth env (secret refs), merged at spawn
  installHint: string; // shown when not detected — how to get set up
}

/** A preset plus the result of probing the local machine for the underlying tool. */
export interface AcpAgentPresetStatus extends AcpAgentPreset {
  installed: boolean; // the tool looks present / logged in
  resolvedBinPath?: string; // the CLI binary we found, if any (informational)
}

interface PresetDef extends AcpAgentPreset {
  binName: string; // PATH lookup name
  binCandidates: string[]; // extra absolute paths to probe (app bundles etc.)
  setupPaths: string[]; // login/config dirs that imply the tool is configured
}

const home = homedir();

// Codex.app bundles the CLI here but does NOT symlink it onto PATH, so probe the bundle directly.
const CODEX_APP_BIN = '/Applications/Codex.app/Contents/Resources/codex';

// Pin the adapter versions: `npx -y <pkg>@<ver>` resolves a known build instead of silently pulling
// `latest` (which could ship a breaking change on the next delegation). Bump these deliberately.
// Both adapters have moved to @agentclientprotocol scope; the old @zed-industries names are deprecated.
const CLAUDE_AGENT_ACP_PKG = '@agentclientprotocol/claude-agent-acp@0.49.0';
const CODEX_ACP_PKG = '@agentclientprotocol/codex-acp@1.0.0';

const PRESETS: PresetDef[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    productIcon: 'claude-code',
    command: 'npx',
    args: ['-y', CLAUDE_AGENT_ACP_PKG],
    // Best-effort: forward ANTHROPIC_API_KEY if set in the daemon env; silently skip if not, so the
    // adapter can fall back to ~/.claude OAuth credentials.
    env: { ANTHROPIC_API_KEY: '${env:' + 'ANTHROPIC_API_KEY}' },
    installHint:
      'Install Claude Code (npm i -g @anthropic-ai/claude-code) and run `claude` to log in, or set ANTHROPIC_API_KEY.',
    binName: 'claude',
    binCandidates: [join(home, '.local', 'bin', 'claude')],
    setupPaths: [join(home, '.claude')]
  },
  {
    id: 'codex',
    label: 'Codex',
    productIcon: 'codex',
    command: 'npx',
    args: ['-y', CODEX_ACP_PKG],
    // Best-effort: forward OPENAI_API_KEY if set in the daemon env; silently skip if not.
    env: { OPENAI_API_KEY: '${env:' + 'OPENAI_API_KEY}' },
    installHint: 'Install Codex (the Codex.app or npm i -g @openai/codex) and run `codex login`.',
    binName: 'codex',
    binCandidates: [CODEX_APP_BIN, join(home, '.codex', 'plugins', '.plugin-appserver', 'codex')],
    setupPaths: [join(home, '.codex')]
  }
];

/** Probe every preset against this machine. Pure read-only (which + existsSync), safe to call often.
 *  Probes are injectable (shared BinProbes) so the codex-not-on-PATH app-bundle fallback is testable. */
export function listAcpAgentPresets(probes: BinProbes = defaultBinProbes): AcpAgentPresetStatus[] {
  return PRESETS.map((def) => {
    const { binName, binCandidates, setupPaths, ...preset } = def;
    const resolvedBinPath = resolveBinary(binName, binCandidates, probes);
    const loggedIn = setupPaths.some((p) => probes.exists(p));
    return { ...preset, installed: Boolean(resolvedBinPath) || loggedIn, resolvedBinPath };
  });
}

export function productIconForAcpAgent(name: string): NativeCliProductIcon | undefined {
  return PRESETS.find((preset) => preset.id === name)?.productIcon;
}
