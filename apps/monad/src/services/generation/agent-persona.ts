// Per-agent persona resolver for the Studio agent layer. The agent loop builds its system prompt
// per turn via a SYNC `instructions(sessionId)` callback (it can't await mid-prompt), so this service
// keeps an in-memory cache of every configured agent's AGENT.md body, hot-reloaded when the agents
// dir changes. `resolve(sessionId)` maps session → bound agent → cached body; a miss falls back to
// the global workspace AGENT slot handled by the caller.

import type { MonadConfig, MonadPaths } from '@monad/home';
import type { AgentAtoms } from '@monad/protocol';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveEffectiveSandboxMode } from '@/config/resolve.ts';
import { loadAgentBody, toAgentDir } from '@/store/home/agent-def.ts';

type AgentConfigRow = MonadConfig['agent']['agents'][number];

/** A Studio agent that may be invoked as a subagent (`visibility.subagentCallable`), resolved with its
 *  persona body so `agent_delegate_to` can run it under its own AGENT.md + narrowed tool set. */
export interface DelegatableAgent {
  name: string;
  description?: string;
  atoms?: AgentAtoms;
  /** AGENT.md system-prompt body, or undefined (the subagent loop falls back to DEFAULT_SYSTEM_PROMPT). */
  instructions?: string;
  /** Per-agent model alias/tier, or undefined (inherits the parent default). */
  model?: string;
}

/**
 * Per-agent tool exposure policy (the picker's `atoms.allow/deny` made executable). A tool's `source`
 * is the atom-pack / MCP-server name it came from, or undefined for a built-in. Rules:
 *   - `deny` always removes (by tool name OR source) — wins over everything.
 *   - built-ins are never gated by the allowlist (they're the agent's base capability set).
 *   - `inherit` exposes everything else; `allowlist` exposes a pack/server tool only when its source
 *     (or the exact tool name) is in `allow`.
 * Exposure ⊆ registration: this only narrows the daemon-registered tools, never grants new ones.
 */
export function isToolExposed(atoms: AgentAtoms | undefined, toolName: string, source?: string): boolean {
  if (!atoms) return true;
  if (atoms.deny.includes(toolName) || (source !== undefined && atoms.deny.includes(source))) return false;
  if (atoms.mode === 'inherit') return true;
  if (source === undefined) return true; // built-in tools aren't gated by the allowlist
  return atoms.allow.includes(source) || atoms.allow.includes(toolName);
}

/** Minimal sync session lookup (the store's `getSession`). */
export interface SessionAgentLookup {
  getSession(id: string): { agentIds: string[] } | null;
}

export class AgentPersonaService {
  private bodies = new Map<string, string>(); // agentId → AGENT.md system-prompt body
  private lastConfig?: MonadConfig; // remembered so a bodiless reload (fs watcher) sees the latest agents

  constructor(
    private readonly paths: MonadPaths,
    private readonly store: SessionAgentLookup
  ) {}

  /** (Re)load every configured agent's AGENT.md body. Pass `cfg` on a config commit (agents may have
   *  changed); call with no arg from the agents-dir watcher to re-read bodies for the known agents. */
  async reload(cfg?: MonadConfig): Promise<void> {
    const config = cfg ?? this.lastConfig;
    if (config) this.lastConfig = config;
    const next = new Map<string, string>();
    for (const a of config?.agent.agents ?? []) {
      const body = await loadAgentBody(this.paths.agents, a.dir ?? toAgentDir(a.name));
      if (body) next.set(a.id, body);
    }
    this.bodies = next;
  }

  /** The session's agent persona body, or undefined (→ caller falls back to the workspace AGENT slot). */
  resolve(sessionId?: string): string | undefined {
    if (!sessionId) return undefined;
    const agentId = this.store.getSession(sessionId)?.agentIds[0];
    return agentId ? this.bodies.get(agentId) : undefined;
  }

  /** The session's bound agent's atoms policy, or undefined (no agent / no policy → unrestricted).
   *  Feeds `isToolExposed` so the per-session toolFilter narrows tools to the agent's allow/deny. */
  atomsFor(sessionId?: string): AgentAtoms | undefined {
    return this.boundAgent(sessionId)?.atoms;
  }

  /** The fs sandbox roots for the session's bound agent's `sandbox` override, with the global ceiling
   *  applied (`resolveEffectiveSandboxMode`). Returns undefined when there is no per-agent override, so
   *  the caller inherits the daemon default. Narrow-only by design: `workspace` jails to the agent's own
   *  dir, `home` to the home dir; `ephemeral` defers to the per-session disposable root (created
   *  out-of-band by SessionSandboxService) and `unrestricted` never widens past the daemon default from
   *  here — both yield undefined. (An explicit-unrestricted widening isn't expressible at this layer:
   *  the loop reads `opts.sandboxRoots ?? config.sandboxRoots`, so undefined means "inherit", and `[]`
   *  would jail to nothing.) */
  sandboxRootsFor(sessionId?: string): string[] | undefined {
    const agent = this.boundAgent(sessionId);
    if (!agent?.sandbox) return undefined;
    const global = this.lastConfig?.agent.globalSandbox ?? { enabled: false, mode: 'workspace' as const };
    const mode = resolveEffectiveSandboxMode(agent.sandbox, global);
    if (mode === 'home') return [homedir()];
    if (mode === 'workspace') return [join(this.paths.agents, agent.dir ?? toAgentDir(agent.name))];
    return undefined;
  }

  /** Every agent flagged `visibility.subagentCallable`, resolved with its cached AGENT.md persona.
   *  Feeds `agent_delegate_to`'s roster; empty → the daemon doesn't mount the named-delegate tool. */
  delegatableAgents(): DelegatableAgent[] {
    return (this.lastConfig?.agent.agents ?? [])
      .filter((a) => a.visibility?.subagentCallable)
      .map((a) => ({
        name: a.name,
        description: a.description,
        atoms: a.atoms,
        instructions: this.bodies.get(a.id),
        model: a.model
      }));
  }

  /** The session's bound agent config row (first bound agent), or undefined. */
  private boundAgent(sessionId?: string): AgentConfigRow | undefined {
    if (!sessionId) return undefined;
    const agentId = this.store.getSession(sessionId)?.agentIds[0];
    if (!agentId) return undefined;
    return this.lastConfig?.agent.agents.find((a) => a.id === agentId);
  }
}
