// First-party slash commands. Authored with the SAME defineCommand the atom pack SDK exposes, so
// first- and third-party commands share one mechanism (the registry just gives these priority).

import type { CommandDefinition } from '@monad/sdk-atom';

import { defineCommand } from '@monad/sdk-atom';

const newSessionCommandAtom = defineCommand({
  name: 'new',
  aliases: ['start'],
  description: 'Start a new conversation',
  descriptionKey: 'cmd.new.desc',
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
  argHint: '<number|session-id>',
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
  async run(ctx) {
    const { compacted, summary } = await ctx.compact();
    return {
      message: compacted > 0 ? ctx.t('cmd.compact.done') : ctx.t('cmd.compact.noop'),
      effect: { type: 'compacted', compacted, ...(summary ? { summary } : {}) }
    };
  }
});

const consolidateCommandAtom = defineCommand({
  name: 'consolidate',
  aliases: ['memory'],
  description: 'Consolidate memory: dedup facts, then update the graph and laws (to your memory level)',
  descriptionKey: 'cmd.consolidate.desc',
  async run(ctx) {
    // Optional depth override: `/consolidate 2` forces L1+L2 regardless of memory.level.
    const arg = Number.parseInt(ctx.args.trim(), 10);
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
});

const whyCommandAtom = defineCommand({
  name: 'why',
  description: 'Explain why the agent believes something, traced through its memory',
  descriptionKey: 'cmd.why.desc',
  async run(ctx) {
    const query = ctx.args.trim();
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
});

const checkMemoryCommandAtom = defineCommand({
  name: 'check-memory',
  description: 'Flag learned rules contradicted by a current fact (suppresses them until re-derived)',
  descriptionKey: 'cmd.checkMemory.desc',
  async run(ctx) {
    const { flagged } = await ctx.checkMemory();
    return { message: ctx.t('cmd.checkMemory.done', { flagged: String(flagged) }) };
  }
});

const clearCommandAtom = defineCommand({
  name: 'clear',
  description: 'Clear the view (client-side)',
  descriptionKey: 'cmd.clear.desc',
  async run() {
    // Server-side no-op; rich clients clear their transcript view on this effect.
    return { effect: { type: 'view-clear' } };
  }
});

const modelCommandAtom = defineCommand({
  name: 'model',
  description: 'Show or switch the model for this conversation',
  descriptionKey: 'cmd.model.desc',
  argHint: '[alias]',
  async run(ctx) {
    const alias = ctx.args.trim();
    const models = await ctx.listModels();
    if (!alias) {
      if (models.length === 0) return { message: ctx.t('cmd.model.none') };
      const lines = models.map((m) => `${m.current ? '➡️' : '  '} ${m.alias}  (${m.provider}:${m.modelId})`);
      return { message: ctx.t('cmd.model.list', { list: lines.join('\n') }) };
    }
    if (!models.some((m) => m.alias === alias)) {
      return { message: ctx.t('cmd.model.unknown', { alias }) };
    }
    await ctx.setModel(alias);
    return { message: ctx.t('cmd.model.set', { alias }), effect: { type: 'model-changed', alias } };
  }
});

const workdirCommandAtom = defineCommand({
  name: 'workdir',
  aliases: ['cwd'],
  description: 'Show or set the shared working folder for this conversation',
  descriptionKey: 'cmd.workdir.desc',
  argHint: '[absolute path]',
  // Owner-only: the working folder controls the fs/shell sandbox root for every agent in the room.
  access: 'owner',
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
  async run(ctx) {
    const commands = await ctx.listCommands();
    const builtins = commands.filter((c) => c.kind === 'builtin' && c.source === 'builtin');
    const atoms = commands.filter((c) => c.source === 'atom');
    const skills = commands.filter((c) => c.kind === 'prompt');
    const fmt = (c: (typeof commands)[number]) => `  /${c.name}${c.argHint ? ` ${c.argHint}` : ''} — ${c.description}`;
    const sections: string[] = [`${ctx.t('cmd.help.commands')}\n${builtins.map(fmt).join('\n')}`];
    if (atoms.length > 0) sections.push(`${ctx.t('cmd.help.atoms')}\n${atoms.map(fmt).join('\n')}`);
    if (skills.length > 0) sections.push(`${ctx.t('cmd.help.skills')}\n${skills.map(fmt).join('\n')}`);
    return { message: sections.join('\n\n'), effect: { type: 'help', commands } };
  }
});

export const BUILTIN_COMMANDS: CommandDefinition[] = [
  newSessionCommandAtom,
  sessionsCommandAtom,
  switchSessionCommandAtom,
  endCommandAtom,
  resetCommandAtom,
  compactCommandAtom,
  consolidateCommandAtom,
  whyCommandAtom,
  checkMemoryCommandAtom,
  clearCommandAtom,
  modelCommandAtom,
  workdirCommandAtom,
  handoffCommandAtom,
  helpCommandAtom
];
