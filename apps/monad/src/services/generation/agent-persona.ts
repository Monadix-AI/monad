// Per-agent persona resolver for the Studio agent layer. The agent loop builds its system prompt
// per turn via a SYNC `instructions(sessionId)` callback (it can't await mid-prompt), so this service
// keeps an in-memory cache of every configured agent's AGENT.md body, hot-reloaded when the agents
// dir changes. `resolve(sessionId)` maps session → bound agent → cached body; a miss falls back to
// the global workspace AGENT slot handled by the caller.

import type { MonadAuth, MonadConfig, MonadPaths } from '@monad/environment';
import type { AgentAtoms, AgentPromptSlots } from '@monad/protocol';
import type { AgentCredentialManifestItem, LoadedSkill } from '#/agent/index.ts';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveEffectiveSandboxMode } from '#/config/resolve.ts';
import { loadAgentPromptSlots, toAgentDir } from '#/store/home/agent-def.ts';

type AgentConfigRow = MonadConfig['agent']['agents'][number];

const BUILTIN_TOOL_CAPABILITY: Record<string, string> = {
  code_execute: 'tool:code-execution',
  email_send: 'tool:email-messaging',
  file_glob: 'tool:file-system',
  file_grep: 'tool:file-system',
  file_patch: 'tool:file-system',
  file_read: 'tool:file-system',
  file_write: 'tool:file-system',
  graph_explore: 'tool:memory',
  graph_node: 'tool:memory',
  memory_forget: 'tool:memory',
  memory_recall: 'tool:memory',
  memory_remember: 'tool:memory',
  monitor_watch: 'tool:schedule-automation',
  net_fetch: 'tool:network-access',
  process_control: 'tool:process-runtime',
  schedule_cancel: 'tool:schedule-automation',
  schedule_create: 'tool:schedule-automation',
  schedule_list: 'tool:schedule-automation',
  send_later: 'tool:schedule-automation',
  shell_exec: 'tool:shell-terminal',
  todo_read: 'tool:task-list',
  todo_write: 'tool:task-list',
  web_extract: 'tool:web-extraction',
  web_search: 'tool:web-search'
};

const MEMORY_TOOLS = new Set(['memory_forget', 'memory_recall', 'memory_remember']);

/** A Studio agent that may be invoked as a subagent (`visibility.subagentCallable`), resolved with its
 *  persona body so `agent_delegate_to` can run it under its own AGENT.md + narrowed tool set. */
export interface DelegatableAgent {
  name: string;
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
 *   - `inherit` exposes everything else.
 *   - `allowlist` gates catalogued built-ins plus sourced tools by capability id, source, or exact
 *     tool name. Internal control tools that aren't exposed in the editor remain available.
 * Exposure ⊆ registration: this only narrows the daemon-registered tools, never grants new ones.
 */
export function isToolExposed(atoms: AgentAtoms | undefined, toolName: string, source?: string): boolean {
  if (!atoms) return true;
  if (atoms.deny.includes(toolName) || (source !== undefined && atoms.deny.includes(source))) return false;
  if (atoms.mode === 'inherit') return true;
  const capability = source === undefined ? BUILTIN_TOOL_CAPABILITY[toolName] : undefined;
  if (source === undefined && capability === undefined) return true;
  return (
    atoms.allow.includes(toolName) ||
    (capability !== undefined && atoms.allow.includes(capability)) ||
    (source !== undefined && atoms.allow.includes(source))
  );
}

/** Minimal sync session lookup (the store's `getSession`). */
export interface SessionAgentLookup {
  getSession(id: string): { agentIds: string[] } | null;
}

export class AgentPersonaService {
  private promptSlots = new Map<string, AgentPromptSlots>();
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
    const next = new Map<string, AgentPromptSlots>();
    for (const a of config?.agent.agents ?? []) {
      const slots = await loadAgentPromptSlots(this.paths.agents, a.dir ?? toAgentDir(a.name));
      next.set(a.id, slots);
    }
    this.promptSlots = next;
  }

  /** The session's agent persona body, or undefined (→ caller falls back to the workspace AGENT slot). */
  resolve(sessionId?: string): string | undefined {
    return this.resolvePromptSlots(sessionId)?.agent || undefined;
  }

  resolvePromptSlots(sessionId?: string): AgentPromptSlots | undefined {
    if (!sessionId) return undefined;
    const agentId = this.store.getSession(sessionId)?.agentIds[0];
    return agentId ? this.promptSlots.get(agentId) : undefined;
  }

  credentialManifestFor(
    sessionId: string | undefined,
    snapshot: { cfg: MonadConfig; auth: MonadAuth | null }
  ): AgentCredentialManifestItem[] {
    if (!sessionId || !snapshot.auth) return [];
    const agentId = this.store.getSession(sessionId)?.agentIds[0];
    const agent = snapshot.cfg.agent.agents.find((candidate) => candidate.id === agentId);
    if (!agent) return [];
    return agent.credentialIds.flatMap((credentialId) => {
      const credential = snapshot.auth?.credentials[credentialId];
      if (!credential) return [];
      return [
        {
          label: credential.label,
          ...(credential.description ? { description: credential.description } : {}),
          environmentVariable: credential.environmentVariable,
          allowedHosts: [...credential.allowedHosts]
        }
      ];
    });
  }

  /** The session's bound agent's atoms policy, or undefined (no agent / no policy → unrestricted).
   *  Feeds `isToolExposed` so the per-session toolFilter narrows tools to the agent's allow/deny. */
  atomsFor(sessionId?: string): AgentAtoms | undefined {
    return this.boundAgent(sessionId)?.atoms;
  }

  /** Whether the session's bound agent opted in to consuming Monadix (`monadix.consume`). Gates the
   *  `monadix__*` tools per agent so only agents the user enabled can delegate OUT to the network. */
  monadixConsumesFor(sessionId?: string): boolean {
    return this.boundAgent(sessionId)?.monadix?.consume === true;
  }

  skillsFor(sessionId: string | undefined, skills: LoadedSkill[]): LoadedSkill[] {
    const agent = this.boundAgent(sessionId);
    const agentDir = agent ? (agent.dir ?? toAgentDir(agent.name)) : undefined;
    const disabled = new Set(agent?.skills?.disabled ?? []);
    const allow = new Set(agent?.skills?.allow ?? []);
    const allowlist = agent?.skills?.mode === 'allowlist';
    const autoload = agent?.skills?.autoload !== false;
    return skills.flatMap((skill) => {
      const privateMatch = /^agent:([^:]+):/.exec(skill.name);
      if (privateMatch && privateMatch[1] !== agentDir) return [];
      if (autoload && !disabled.has(skill.name) && (!allowlist || allow.has(skill.name))) return [skill];
      return [{ ...skill, modelInvocable: false }];
    });
  }

  agentDirFor(sessionId?: string): string | undefined {
    const agent = this.boundAgent(sessionId);
    return agent ? (agent.dir ?? toAgentDir(agent.name)) : undefined;
  }

  privateCapabilityAllowed(sessionId: string | undefined, source: string | undefined): boolean | undefined {
    if (!source) return undefined;
    const match = /^agent:([^:]+):mcp:/.exec(source);
    return match ? this.agentDirFor(sessionId) === match[1] : undefined;
  }

  toolAllowed(sessionId: string | undefined, toolName: string, source: string | undefined): boolean {
    if (toolName.startsWith('monadix__')) return this.monadixConsumesFor(sessionId);
    if (MEMORY_TOOLS.has(toolName) && this.boundAgent(sessionId)?.memory.enabled !== true) return false;
    const privateAllowed = this.privateCapabilityAllowed(sessionId, source);
    if (privateAllowed === false) return false;
    return isToolExposed(this.atomsFor(sessionId), toolName, source);
  }

  /** The fs sandbox roots for the session's bound agent, with the global ceiling applied
   *  (`resolveEffectiveSandboxMode`). A bound agent without an explicit `sandbox` defaults to
   *  `workspace`, so monad-owned agents are jailed to their own agent dir by default. Narrow-only:
   *  `workspace` jails to the agent's own
   *  dir, `home` to the home dir; `ephemeral` defers to the per-session disposable root (created
   *  out-of-band by SessionSandboxService) and `unrestricted` never widens past the daemon default from
   *  here — both yield undefined. (An explicit-unrestricted widening isn't expressible at this layer:
   *  the loop reads `opts.sandboxRoots ?? config.sandboxRoots`, so undefined means "inherit", and `[]`
   *  would jail to nothing.) */
  sandboxRootsFor(sessionId?: string): string[] | undefined {
    const agent = this.boundAgent(sessionId);
    if (!agent) return undefined;
    const global = this.lastConfig?.agent.globalSandbox ?? { enabled: false, mode: 'workspace' as const };
    const mode = resolveEffectiveSandboxMode(agent.sandbox ?? { mode: 'workspace' as const }, global);
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
        atoms: a.atoms,
        instructions: this.promptSlots.get(a.id)?.agent || undefined,
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
