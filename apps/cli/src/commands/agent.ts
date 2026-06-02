import type { Agent, AgentId, CreateAgentRequest, UpdateAgentRequest } from '@monad/protocol';
import type { CommandContext, CommandDef } from './types.ts';

import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, green, json, out, red } from '../lib/output.ts';
import { renderTable } from '../lib/table.ts';
import { requireTreatyData } from '../lib/treaty.ts';
import { usageError } from './types.ts';

const FRAMEWORKS = ['openclaw', 'hermes', 'manus', 'monad', 'custom'] as const;
type Framework = (typeof FRAMEWORKS)[number];

const SANDBOX_MODES = ['workspace', 'home', 'unrestricted', 'ephemeral'] as const;
type SandboxMode = (typeof SANDBOX_MODES)[number];

function str(flags: Record<string, unknown>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' && value ? value : undefined;
}

function framework(flags: Record<string, unknown>): Framework | undefined {
  const value = str(flags, 'framework');
  if (value === undefined) return undefined;
  if (!(FRAMEWORKS as readonly string[]).includes(value)) {
    throw usageError(t('cli.agent.badFramework', { list: FRAMEWORKS.join(', ') }));
  }
  return value as Framework;
}

function sandboxMode(flags: Record<string, unknown>): SandboxMode | undefined {
  const value = str(flags, 'sandbox');
  if (value === undefined) return undefined;
  if (!(SANDBOX_MODES as readonly string[]).includes(value)) {
    throw usageError(t('cli.agent.badSandbox', { list: SANDBOX_MODES.join(', ') }));
  }
  return value as SandboxMode;
}

function positive(flags: Record<string, unknown>, key: string): number | undefined {
  const value = flags[key];
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw usageError(t('cli.agent.badNumber', { flag: key }));
  return parsed;
}

/** The budget and containment knobs a headless run needs set before it starts, not after. */
function limits(flags: Record<string, unknown>) {
  const maxTurns = positive(flags, 'max-turns');
  const maxBudgetUsd = positive(flags, 'max-budget-usd');
  const mode = sandboxMode(flags);
  return {
    ...(maxTurns === undefined ? {} : { maxTurns: Math.trunc(maxTurns) }),
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    ...(mode ? { sandboxMode: mode } : {}),
    ...(flags['subagent-callable'] === undefined
      ? {}
      : { visibility: { subagentCallable: flags['subagent-callable'] === true, public: false } })
  };
}

/** Resolve a positional to an agent id, accepting either the id itself or the agent's name. */
async function resolveAgentId(client: CommandContext['client'], ref: string): Promise<AgentId> {
  const { agents } = requireTreatyData(await client.treaty.v1.agents.get());
  const match = agents.find((agent) => agent.id === ref) ?? agents.find((agent) => agent.name === ref);
  if (!match) throw usageError(t('cli.agent.notFound', { ref }));
  return match.id;
}

function modelOf(agent: Agent): string {
  return agent.model ?? agent.modelAlias ?? 'inherit';
}

async function list(client: CommandContext['client']): Promise<void> {
  const [{ agents }, { agentId: defaultId }] = await Promise.all([
    client.treaty.v1.agents.get().then(requireTreatyData),
    client.treaty.v1.agents.default.get().then(requireTreatyData)
  ]);
  json({ agents, defaultAgentId: defaultId });
  if (agents.length === 0) {
    out(dim(t('cli.empty.agents')));
    return;
  }
  out(
    renderTable(
      [t('cli.agent.col.id'), t('cli.agent.col.name'), t('cli.agent.col.model'), t('cli.agent.col.framework'), ''],
      agents.map((agent) => [
        agent.id,
        agent.name,
        modelOf(agent),
        agent.framework ?? 'monad',
        agent.id === defaultId ? t('cli.agent.defaultMarker') : ''
      ])
    )
  );
}

async function show(client: CommandContext['client'], ref: string | undefined): Promise<void> {
  if (!ref) throw usageError('usage: monad agent show <agentId|name>');
  const id = await resolveAgentId(client, ref);
  const { agent } = requireTreatyData(await client.treaty.v1.agents({ id }).get());
  json(agent);
  out(bold(agent.name) + dim(`  ${agent.id}`));
  out(dim(`  ${t('cli.agent.col.model')}: `) + modelOf(agent));
  out(dim(`  ${t('cli.agent.col.framework')}: `) + (agent.framework ?? 'monad'));
  if (agent.sandboxMode) out(dim('  sandbox: ') + agent.sandboxMode);
  if (agent.maxTurns !== undefined) out(dim('  max turns: ') + agent.maxTurns);
  if (agent.maxBudgetUsd !== undefined) out(`${dim('  max budget: ')}$${agent.maxBudgetUsd}`);
  if (agent.capabilities.length) out(dim('  capabilities: ') + agent.capabilities.join(', '));
  out(dim('  prompt: ') + (agent.hasPrompt ? t('cli.agent.promptSet') : t('cli.agent.promptEmpty')));
}

async function create(client: CommandContext['client'], name: string | undefined, flags: Record<string, unknown>) {
  if (!name) throw usageError('usage: monad agent new <name> [--model <alias>] [--framework <f>] [--prompt <text>]');
  const body: CreateAgentRequest = {
    name,
    capabilities: [],
    credentialIds: [],
    memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
    ...(str(flags, 'model') ? { model: str(flags, 'model') } : {}),
    ...(framework(flags) ? { framework: framework(flags) } : {}),
    ...(str(flags, 'prompt') ? { prompt: str(flags, 'prompt') } : {}),
    ...limits(flags)
  };
  const { agent } = requireTreatyData(await client.treaty.v1.agents.post(body));
  json(agent);
  out(green(t('cli.created')) + dim('  ') + cyan(agent.id) + dim(`  ${agent.name}`));
}

async function update(client: CommandContext['client'], ref: string | undefined, flags: Record<string, unknown>) {
  if (!ref) throw usageError('usage: monad agent set <agentId|name> [--name <n>] [--model <alias>] [--framework <f>]');
  const patch: UpdateAgentRequest = {
    ...(str(flags, 'name') ? { name: str(flags, 'name') } : {}),
    ...(str(flags, 'model') ? { model: str(flags, 'model') } : {}),
    ...(framework(flags) ? { framework: framework(flags) } : {}),
    ...limits(flags)
  };
  if (Object.keys(patch).length === 0) throw usageError(t('cli.agent.nothingToSet'));
  const id = await resolveAgentId(client, ref);
  const { agent } = requireTreatyData(await client.treaty.v1.agents({ id }).patch(patch));
  json(agent);
  out(green(t('cli.updated')) + dim('  ') + cyan(agent.id) + dim(`  ${agent.name}`));
}

async function remove(client: CommandContext['client'], ref: string | undefined): Promise<void> {
  if (!ref) throw usageError('usage: monad agent rm <agentId|name>');
  const id = await resolveAgentId(client, ref);
  const { ok } = requireTreatyData(await client.treaty.v1.agents({ id }).delete());
  json({ ok, agentId: id });
  out((ok ? green(t('cli.deleted')) : red(t('cli.failed'))) + dim(`  ${id}`));
}

/** `prompt <ref>` reads the AGENT.md body; with `<text|->` it replaces it. */
async function prompt(client: CommandContext['client'], ref: string | undefined, rest: string[]): Promise<void> {
  if (!ref) throw usageError('usage: monad agent prompt <agentId|name> [text|-]');
  const id = await resolveAgentId(client, ref);
  const body = rest.length === 1 && rest[0] === '-' ? await Bun.stdin.text() : rest.join(' ');
  if (!body) {
    const current = requireTreatyData(await client.treaty.v1.agents({ id }).prompt.get());
    json(current);
    out(current.prompt);
    return;
  }
  const updated = requireTreatyData(await client.treaty.v1.agents({ id }).prompt.put({ prompt: body }));
  json(updated);
  out(green(t('cli.updated')) + dim(`  ${id}`));
}

/** `use` with no argument reports the current default agent; with one it sets it. */
async function resolveDefault(client: CommandContext['client'], ref: string | undefined): Promise<void> {
  if (!ref) {
    const current = requireTreatyData(await client.treaty.v1.agents.default.get());
    json(current);
    out(current.agentId ? cyan(current.agentId) : dim(t('cli.agent.noDefault')));
    return;
  }
  const agentId = await resolveAgentId(client, ref);
  requireTreatyData(await client.treaty.v1.agents.default.put({ agentId }));
  json({ agentId });
  out(green(t('cli.agent.defaultSet')) + dim(`  ${agentId}`));
}

// The agent team roster: the daemon's `agents.*` surface, which until now was reachable only from
// the init wizard and the web UI. `monad agent` is the headless way to build and steer a team.
export const command: CommandDef = {
  name: 'agent',
  group: 'work',
  synopsis: 'agent <list|show|new|set|rm|prompt|use> [agentId|name]',
  subcommands: ['list', 'show', 'new', 'set', 'rm', 'prompt', 'use'],
  description: 'manage the agent team (list, show, new, set, rm, prompt, use)',
  descriptionKey: 'cli.cmd.agent.desc',
  flags: {
    model: { type: 'string', description: 'model profile alias', descriptionKey: 'cli.agent.flag.model' },
    framework: {
      type: 'string',
      description: 'runtime framework: openclaw | hermes | manus | monad | custom',
      descriptionKey: 'cli.agent.flag.framework'
    },
    name: { type: 'string', description: 'new display name (agent set)', descriptionKey: 'cli.agent.flag.name' },
    prompt: {
      type: 'string',
      description: 'initial AGENT.md body (agent new)',
      descriptionKey: 'cli.agent.flag.prompt'
    },
    sandbox: {
      type: 'string',
      description: 'sandbox mode: workspace | home | unrestricted | ephemeral',
      descriptionKey: 'cli.agent.flag.sandbox'
    },
    'max-turns': {
      type: 'number',
      description: 'stop the agent after this many turns',
      descriptionKey: 'cli.agent.flag.maxTurns'
    },
    'max-budget-usd': {
      type: 'number',
      description: 'stop the agent once this much has been spent',
      descriptionKey: 'cli.agent.flag.maxBudget'
    },
    'subagent-callable': {
      type: 'boolean',
      description: 'let other agents delegate to this one',
      descriptionKey: 'cli.agent.flag.subagentCallable'
    }
  },
  async run({ positionals, flags, client }) {
    const [action = 'list', ref, ...rest] = positionals;
    switch (action) {
      case 'list':
      case 'ls':
        return list(client);
      case 'show':
      case 'get':
        return show(client, ref);
      case 'new':
      case 'create':
        return create(client, ref, flags);
      case 'set':
      case 'update':
        return update(client, ref, flags);
      case 'rm':
      case 'remove':
      case 'delete':
        return remove(client, ref);
      case 'prompt':
        return prompt(client, ref, rest);
      case 'use':
      case 'default':
        return resolveDefault(client, ref);
      default:
        throw usageError(t('cli.agent.unknownAction', { action }));
    }
  }
};
