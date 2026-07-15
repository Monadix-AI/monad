// First-party slash commands. Authored with the SAME defineCommand the atom pack SDK exposes, so
// first- and third-party commands share one mechanism (the registry just gives these priority).

import type { CommandDefinition } from '@monad/sdk-atom';

import { defineCommand } from '@monad/sdk-atom';

const newSessionCommandAtom = defineCommand({
  name: 'new',
  aliases: ['start'],
  description: 'Start a new conversation',
  descriptionKey: 'cmd.new.desc',
  group: 'Conversation',
  argHint: '[label]',
  async run(ctx) {
    const label = ctx.args.trim() || undefined;
    const { sessionId } = await ctx.newSession(label);
    return { message: ctx.t('cmd.new.started'), effect: { type: 'session-created', sessionId } };
  }
});

const sessionsCommandAtom = defineCommand({
  name: 'sessions',
  aliases: ['ls'],
  description: 'List conversations',
  descriptionKey: 'cmd.sessions.desc',
  group: 'Conversation',
  async run(ctx) {
    const list = await ctx.listSessions();
    if (list.length === 0) return { message: ctx.t('cmd.sessions.empty') };
    const lines = list.map((s, i) => `${s.active ? '➡️' : '  '} ${i + 1}. ${s.label ?? s.sessionId}`);
    return { message: ctx.t('cmd.sessions.list', { list: lines.join('\n') }) };
  }
});

const switchSessionCommandAtom = defineCommand({
  name: 'switch',
  description: 'Switch to another conversation',
  descriptionKey: 'cmd.switch.desc',
  group: 'Conversation',
  argHint: '<number|session-id>',
  args: [{ name: 'target', type: 'session', required: true, placeholder: '<number|session-id>' }],
  async run(ctx) {
    const target = ctx.args.trim().split(/\s+/)[0];
    if (!target) return { message: ctx.t('cmd.switch.usage') };
    const found = await ctx.switchSession(target);
    if (!found) return { message: ctx.t('cmd.switch.notFound', { target }) };
    return {
      message: ctx.t('cmd.switch.done', { label: found.label ?? found.sessionId }),
      effect: { type: 'session-switched', sessionId: found.sessionId }
    };
  }
});

const endCommandAtom = defineCommand({
  name: 'end',
  description: 'End the current conversation and start fresh',
  descriptionKey: 'cmd.end.desc',
  group: 'Conversation',
  async run(ctx) {
    const { sessionId } = await ctx.newSession();
    return {
      message: ctx.t('cmd.end.done'),
      effect: { type: 'session-created', sessionId }
    };
  }
});

const resetCommandAtom = defineCommand({
  name: 'reset',
  aliases: ['clear-history'],
  description: 'Clear this conversation’s history',
  descriptionKey: 'cmd.reset.desc',
  group: 'Context',
  async run(ctx) {
    const { clearedCount } = await ctx.resetHistory();
    return {
      message: ctx.t('cmd.reset.done', { count: clearedCount }),
      effect: { type: 'history-reset' }
    };
  }
});

const compactCommandAtom = defineCommand({
  name: 'compact',
  description: 'Summarize and compact the context window now',
  descriptionKey: 'cmd.compact.desc',
  group: 'Context',
  async run(ctx) {
    const { compacted, summary } = await ctx.compact();
    return {
      message: compacted > 0 ? ctx.t('cmd.compact.done') : ctx.t('cmd.compact.noop'),
      effect: { type: 'compacted', compacted, ...(summary ? { summary } : {}) }
    };
  }
});

async function runConsolidate(ctx: Parameters<CommandDefinition['run']>[0], args: string) {
  // Optional depth override: `/consolidate 2` or `/memory consolidate 2` forces L1+L2.
  const arg = Number.parseInt(args.trim(), 10);
  const level = arg >= 1 && arg <= 3 ? arg : undefined;
  const r = await ctx.consolidate(level);
  return {
    message: ctx.t('cmd.consolidate.done', {
      level: String(r.level),
      scopes: String(r.l1Scopes),
      nodes: String(r.nodes),
      edges: String(r.edges),
      laws: String(r.laws)
    })
  };
}

const consolidateCommandAtom = defineCommand({
  name: 'consolidate',
  description: 'Consolidate memory: dedup facts, then update the graph and laws (to your memory level)',
  descriptionKey: 'cmd.consolidate.desc',
  group: 'Memory',
  async run(ctx) {
    return runConsolidate(ctx, ctx.args);
  }
});

async function runWhy(ctx: Parameters<CommandDefinition['run']>[0], args: string) {
  const query = args.trim();
  if (!query) return { message: ctx.t('cmd.why.usage') };
  const { matches } = await ctx.explainBelief(query);
  if (matches.length === 0) return { message: ctx.t('cmd.why.none') };
  const blocks = matches.map((m) => {
    const lines = [`${m.statement} (${Math.round(m.confidence * 100)}%)`];
    if (m.facts.length > 0) lines.push(`  ${ctx.t('cmd.why.facts')}: ${m.facts.join('; ')}`);
    if (m.relations.length > 0) lines.push(`  ${ctx.t('cmd.why.relations')}: ${m.relations.join('; ')}`);
    if (m.sources.length > 0) lines.push(`  ${ctx.t('cmd.why.sources')}: ${m.sources.join(' … ')}`);
    return lines.join('\n');
  });
  return { message: blocks.join('\n\n') };
}

const whyCommandAtom = defineCommand({
  name: 'why',
  description: 'Explain why the agent believes something, traced through its memory',
  descriptionKey: 'cmd.why.desc',
  group: 'Memory',
  async run(ctx) {
    return runWhy(ctx, ctx.args);
  }
});

async function runCheckMemory(ctx: Parameters<CommandDefinition['run']>[0]) {
  const { flagged } = await ctx.checkMemory();
  return { message: ctx.t('cmd.checkMemory.done', { flagged: String(flagged) }) };
}

const checkMemoryCommandAtom = defineCommand({
  name: 'check-memory',
  description: 'Flag learned rules contradicted by a current fact (suppresses them until re-derived)',
  descriptionKey: 'cmd.checkMemory.desc',
  group: 'Memory',
  async run(ctx) {
    return runCheckMemory(ctx);
  }
});

const memoryCommandAtom = defineCommand({
  name: 'memory',
  description: 'Manage memory commands',
  descriptionKey: 'cmd.memory.desc',
  group: 'Memory',
  subcommands: [
    {
      id: 'consolidate',
      name: 'Consolidate',
      description: 'Consolidate memory layers',
      shortcut: 'consolidate',
      args: [{ name: 'level', type: 'enum', values: [{ id: '1' }, { id: '2' }, { id: '3' }] }]
    },
    {
      id: 'why',
      name: 'Why',
      description: 'Explain why the agent believes something',
      shortcut: 'why',
      args: [{ name: 'query', type: 'string', required: true, repeated: true, placeholder: '<query>' }]
    },
    {
      id: 'check',
      name: 'Check',
      description: 'Flag contradicted learned rules',
      aliases: ['check-memory'],
      shortcut: 'check-memory'
    }
  ],
  async run(ctx) {
    const [subcommand, ...rest] = ctx.args.trim().split(/\s+/);
    const args = rest.join(' ');
    if (subcommand === 'consolidate') return runConsolidate(ctx, args);
    if (subcommand === 'why') return runWhy(ctx, args);
    if (subcommand === 'check' || subcommand === 'check-memory') return runCheckMemory(ctx);
    return { message: subcommand ? ctx.t('cmd.memory.unknown', { subcommand }) : ctx.t('cmd.memory.usage') };
  }
});

const clearCommandAtom = defineCommand({
  name: 'clear',
  description: 'Clear the view (client-side)',
  descriptionKey: 'cmd.clear.desc',
  group: 'Context',
  async run() {
    // Server-side no-op; rich clients clear their transcript view on this effect.
    return { effect: { type: 'view-clear' } };
  }
});

const viewCommandAtom = defineCommand({
  name: 'view',
  description: 'Switch local observation rendering mode',
  descriptionKey: 'cmd.view.desc',
  group: 'Context',
  argHint: '<detail|compact>',
  args: [{ name: 'mode', type: 'enum', values: [{ id: 'detail' }, { id: 'compact' }], required: true }],
  async run(ctx) {
    const mode = ctx.args.trim().toLowerCase();
    if (mode !== 'detail' && mode !== 'compact') return { message: ctx.t('cmd.view.usage') };
    return {
      message: ctx.t(mode === 'compact' ? 'cmd.view.compact' : 'cmd.view.detail'),
      effect: { type: 'observation-render-mode-changed', mode }
    };
  }
});

const modelCommandAtom = defineCommand({
  name: 'model',
  description: 'Show or switch the model for this conversation',
  descriptionKey: 'cmd.model.desc',
  group: 'Runtime',
  argHint: '[alias]',
  args: [{ name: 'alias', type: 'model', required: false, placeholder: '[alias]' }],
  async run(ctx) {
    const alias = ctx.args.trim();
    const models = await ctx.listModels();
    if (!alias) {
      if (models.length === 0) return { message: ctx.t('cmd.model.none') };
      const lines = models.map((m) => `${m.current ? '➡️' : '  '} ${m.alias}  (${m.provider}:${m.modelId})`);
      return { message: ctx.t('cmd.model.list', { list: lines.join('\n') }) };
    }
    if (alias === 'inherit') {
      await ctx.setModel(alias);
      return {
        message: ctx.t('cmd.model.set', { alias }),
        effect: { type: 'model-changed', alias }
      };
    }
    const profile = models.find((m) => m.alias === alias);
    if (profile) {
      await ctx.setModel(profile.alias);
      return {
        message: ctx.t('cmd.model.set', { alias: profile.alias }),
        effect: { type: 'model-changed', alias: profile.alias }
      };
    }
    const separator = alias.indexOf(':');
    if (separator > 0 && separator < alias.length - 1) {
      await ctx.setModel(alias);
      return {
        message: ctx.t('cmd.model.set', { alias }),
        effect: { type: 'model-changed', alias }
      };
    }
    const modelMatches = models.filter((m) => m.modelId === alias);
    const providers = new Set(modelMatches.map((m) => m.provider));
    const match = modelMatches[0];
    if (match && providers.size === 1) {
      await ctx.setModel(match.alias);
      return {
        message: ctx.t('cmd.model.set', { alias: match.alias }),
        effect: { type: 'model-changed', alias: match.alias }
      };
    }
    if (providers.size > 1) {
      const lines = modelMatches.map((m) => `${m.provider}: ${m.alias}  (${m.modelId})`);
      return { message: ctx.t('cmd.model.ambiguous', { alias, list: lines.join('\n') }) };
    }
    return { message: ctx.t('cmd.model.unknown', { alias }) };
  }
});

const effortCommandAtom = defineCommand({
  name: 'effort',
  description: 'Set the reasoning effort for this conversation',
  descriptionKey: 'cmd.effort.desc',
  group: 'Runtime',
  argHint: '<value|default>',
  args: [{ name: 'effort', type: 'string', required: true, placeholder: '<value|default>' }],
  async run(ctx) {
    const value = ctx.args.trim();
    if (!value) return { message: ctx.t('cmd.effort.usage') };
    const effort = value === 'default' ? undefined : value;
    await ctx.setEffort(effort);
    return {
      message: ctx.t(effort ? 'cmd.effort.set' : 'cmd.effort.default', effort ? { effort } : undefined),
      effect: { type: 'model-effort-changed', ...(effort ? { effort } : {}) }
    };
  }
});

const workdirCommandAtom = defineCommand({
  name: 'workdir',
  aliases: ['cwd'],
  description: 'Show or set the shared working folder for this conversation',
  descriptionKey: 'cmd.workdir.desc',
  group: 'Runtime',
  argHint: '[absolute path]',
  args: [{ name: 'path', type: 'path', required: false, placeholder: '[absolute path]' }],
  async run(ctx) {
    const path = ctx.args.trim();
    if (!path) {
      const { path: current } = await ctx.getWorkdir();
      return { message: current ? ctx.t('cmd.workdir.show', { path: current }) : ctx.t('cmd.workdir.none') };
    }
    const { path: resolved } = await ctx.setWorkdir(path);
    return {
      message: resolved ? ctx.t('cmd.workdir.set', { path: resolved }) : ctx.t('cmd.workdir.cleared'),
      effect: { type: 'workdir-changed', path: resolved }
    };
  }
});

const handoffCommandAtom = defineCommand({
  name: 'handoff',
  description: 'Summarize this conversation and continue it in a new session',
  descriptionKey: 'cmd.handoff.desc',
  group: 'Conversation',
  argHint: '[initial task for the new session]',
  async run(ctx) {
    const initialTask = ctx.args.trim() || undefined;
    const { sessionId } = await ctx.handoff(initialTask);
    return {
      message: ctx.t('cmd.handoff.done'),
      effect: { type: 'session-created', sessionId }
    };
  }
});

const helpCommandAtom = defineCommand({
  name: 'help',
  aliases: ['commands'],
  description: 'List available commands',
  descriptionKey: 'cmd.help.desc',
  group: 'Help',
  async run(ctx) {
    const commands = await ctx.listCommands();
    const builtins = commands.filter((c) => c.type === 'action' && c.source === 'builtin');
    const atoms = commands.filter((c) => c.type === 'action' && c.source === 'atom-pack');
    const skills = commands.filter((c) => c.type === 'skill');
    const sections: string[] = groupedCommandSections(ctx.t('cmd.help.commands'), builtins, commandHelpBlock, (group) =>
      helpGroupLabel(ctx.t, group)
    );
    if (atoms.length > 0) sections.push(commandHelpSection(ctx.t('cmd.help.atoms'), commandHelpBlock(atoms)));
    if (skills.length > 0) sections.push(commandHelpSection(ctx.t('cmd.help.skills'), commandHelpBlock(skills)));
    return { message: sections.join('\n\n'), effect: { type: 'help', commands } };
  }
});

interface CommandHelpEntry {
  description: string;
  invocation: string;
}

function commandHelpBlock(
  commands: Array<{
    id: string;
    description: string;
    argHint?: string;
    args?: Array<{ name: string; placeholder?: string; required?: boolean }>;
    subcommands?: Array<{
      id: string;
      description: string;
      shortcut?: string;
      args?: Array<{ name: string; placeholder?: string; required?: boolean }>;
    }>;
  }>
): string {
  const entries = commands.flatMap(commandHelpEntries);
  return entries.map((entry) => `- \`${entry.invocation}\` ${entry.description}`).join('\n');
}

function commandHelpEntries(command: {
  id: string;
  description: string;
  argHint?: string;
  args?: Array<{ name: string; placeholder?: string; required?: boolean }>;
  subcommands?: Array<{
    id: string;
    description: string;
    shortcut?: string;
    args?: Array<{ name: string; placeholder?: string; required?: boolean }>;
  }>;
}): CommandHelpEntry[] {
  const rows = [{ invocation: `/${command.id}${commandHint(command)}`, description: command.description }];
  for (const subcommand of command.subcommands ?? []) {
    const shortcut = subcommand.shortcut ? ` (shortcut /${subcommand.shortcut})` : '';
    rows.push({
      invocation: `/${command.id} ${subcommand.id}${commandHint(subcommand)}`,
      description: `${subcommand.description}${shortcut}`
    });
  }
  return rows;
}

function commandHint(command: {
  argHint?: string;
  args?: Array<{ name: string; placeholder?: string; required?: boolean }>;
}): string {
  if (command.argHint) return ` ${command.argHint}`;
  if (!command.args?.length) return '';
  return ` ${command.args.map((arg) => arg.placeholder ?? (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(' ')}`;
}

const COMMAND_GROUP_ORDER = ['Conversation', 'Context', 'Memory', 'Runtime', 'Help'];

function groupedCommandSections<T extends { group?: string }>(
  title: string,
  commands: T[],
  fmt: (commands: T[]) => string,
  label: (group: string) => string
): string[] {
  if (commands.length === 0) return [`${title}\n`];
  const byGroup = new Map<string, T[]>();
  for (const command of commands) {
    const group = command.group ?? 'Other';
    const rows = byGroup.get(group);
    if (rows) rows.push(command);
    else byGroup.set(group, [command]);
  }
  return [...byGroup]
    .toSorted(([a], [b]) => commandGroupRank(a) - commandGroupRank(b) || a.localeCompare(b))
    .map(([group, rows], index) => {
      const heading = index === 0 ? `## ${title}\n\n### ${label(group)}` : `### ${label(group)}`;
      return `${heading}\n${fmt(rows)}`;
    });
}

function commandHelpSection(title: string, body: string): string {
  return `## ${title}\n${body}`;
}

function commandGroupRank(group: string): number {
  const rank = COMMAND_GROUP_ORDER.indexOf(group);
  return rank === -1 ? COMMAND_GROUP_ORDER.length : rank;
}

function helpGroupLabel(t: (key: string) => string, group: string): string {
  const key = group.charAt(0).toLowerCase() + group.slice(1);
  const translated = t(`cmd.help.group.${key}`);
  return translated === `cmd.help.group.${key}` ? group : translated;
}

export const BUILTIN_COMMANDS: CommandDefinition[] = [
  newSessionCommandAtom,
  sessionsCommandAtom,
  switchSessionCommandAtom,
  endCommandAtom,
  resetCommandAtom,
  compactCommandAtom,
  memoryCommandAtom,
  consolidateCommandAtom,
  whyCommandAtom,
  checkMemoryCommandAtom,
  clearCommandAtom,
  viewCommandAtom,
  modelCommandAtom,
  effortCommandAtom,
  workdirCommandAtom,
  handoffCommandAtom,
  helpCommandAtom
];
