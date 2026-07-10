import type { CommandItem, ProfileView, Session } from '@monad/protocol';
import type { TFn } from '#/components/I18nProvider';

import { bestCommandMatch, bestLabelMatch, type FuzzyMatch } from './command-fuzzy-match';

export type CommandMenuProfile = ProfileView;
type CommandReplaceRange = { start: number; end: number };

export interface SessionCommandMenuItem {
  badge?: string;
  dismissAfter?: boolean;
  executeOnSelect?: boolean;
  hint?: string;
  icon?: string;
  insert: string;
  key: string;
  label: string;
  labelMatches?: number[];
  replace?: { start: number; end: number };
  section?: string;
  typeBadge?: string;
  version?: string;
}

export function shouldActivateSlashCommandDiscovery(input: string): boolean {
  const commandNamePhase = /^\/[^\s/]*$/.test(input.trimStart());
  const inlineSkillPhase = /(^|\s)\/[^\s/]*$/.test(input);
  return commandNamePhase || inlineSkillPhase;
}

function itemBadge(command: CommandItem, t: TFn): string | undefined {
  if (command.source === 'atom-pack') return command.sourceName ?? 'atom-pack';
  if (command.source === 'custom') return command.sourceName ?? t('web.skills.sourceGlobal');
  return undefined;
}

function commandMenuRank(command: CommandItem): string {
  if (command.type !== 'skill') return `1:${command.name}:${command.id}`;
  const sourceRank = command.source === 'custom' ? 0 : 1;
  return `0:${command.name}:${sourceRank}:${command.id}`;
}

const COMMAND_GROUP_ORDER = ['Conversation', 'Context', 'Memory', 'Runtime', 'Help'];

function commandGroupRank(command: CommandItem): number {
  if (command.type === 'skill') return 0;
  const rank = command.group ? COMMAND_GROUP_ORDER.indexOf(command.group) : -1;
  return rank === -1 ? COMMAND_GROUP_ORDER.length : rank;
}

function compareCommandMenuItems(a: CommandItem, b: CommandItem): number {
  return commandGroupRank(a) - commandGroupRank(b) || commandMenuRank(a).localeCompare(commandMenuRank(b));
}

function commandHint(command: CommandItem): string {
  if (command.argHint) return ` ${command.argHint}`;
  if (!command.args?.length) return '';
  return ` ${command.args.map((arg) => arg.placeholder ?? (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(' ')}`;
}

function commandSection(command: CommandItem): string {
  return command.type === 'skill' ? 'Skills' : 'Commands';
}

export function skillCommandMeta(command: CommandItem | undefined, t: TFn) {
  if (command?.type !== 'skill') return null;
  return {
    id: command.id,
    label: command.name,
    description: command.description,
    icon: command.icon,
    version: command.version,
    sourceLabel: itemBadge(command, t)
  };
}

export function activeSkillToken(
  text: string,
  commands: CommandItem[],
  t: TFn
): (ReturnType<typeof skillCommandMeta> & { start: number; end: number; raw: string }) | null {
  const token = '[a-z0-9]+(?:-[a-z0-9]+)*';
  const re = new RegExp(`(^|\\s)/(${token}(?::${token}){1,2})(?=\\s|$)`, 'g');
  for (const match of text.matchAll(re)) {
    const id = match[2] as string;
    const command = commands.find((c) => c.type === 'skill' && c.id === id);
    const meta = skillCommandMeta(command, t);
    if (!meta) continue;
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return { ...meta, start, end: start + id.length + 1, raw: `/${id}` };
  }
  return null;
}

export function activeCommandToken(
  text: string,
  commands: CommandItem[]
): { id: string; label: string; start: number; end: number; raw: string } | null {
  const trimmedStart = text.trimStart();
  const leading = text.length - trimmedStart.length;
  const match = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(trimmedStart);
  if (!match) return null;
  const id = match[1] as string;
  const command = commands.find((item) => item.enabled && item.type === 'action' && item.id === id);
  if (!command) return null;
  const start = leading;
  return {
    id,
    label: command.name,
    start,
    end: start + id.length + 1,
    raw: `/${id}`
  };
}

// Builds the `/` autocomplete menu: command-name phase, inline-skill phase, subcommand phase, then
// positional argument suggestions from structured command metadata.
export function buildCommandMenuItems(
  input: string,
  commands: CommandItem[],
  profiles: CommandMenuProfile[],
  sessions: Session[],
  t: TFn
): SessionCommandMenuItem[] {
  const trimmedStart = input.trimStart();
  const commandStart = input.length - trimmedStart.length;
  const commandReplace = { start: commandStart, end: input.length };
  const nameM = /^\/([^\s]*)$/.exec(trimmedStart);
  if (nameM) {
    return buildCommandNameSuggestions({ commands, query: nameM[1] ?? '', replace: commandReplace, t });
  }
  const inlineSkillM = /(^|\s)\/([^\s/]*)$/.exec(input);
  if (inlineSkillM) {
    return buildInlineSkillSuggestions({ commands, input, match: inlineSkillM, t });
  }
  const argM = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmedStart);
  if (argM) {
    return buildCommandArgumentPhaseSuggestions({ commands, match: argM, profiles, replace: commandReplace, sessions });
  }
  return [];
}

function buildCommandNameSuggestions({
  commands,
  query,
  replace,
  t
}: {
  commands: CommandItem[];
  query: string;
  replace: CommandReplaceRange;
  t: TFn;
}): SessionCommandMenuItem[] {
  const q = query.toLowerCase();
  return commands
    .map((c) => {
      if (!c.enabled) return null;
      const match = bestCommandMatch(c, q);
      return match ? { command: c, match } : null;
    })
    .filter((item): item is { command: CommandItem; match: FuzzyMatch & { labelIndices: number[] } } => Boolean(item))
    .toSorted((a, b) => a.match.rank - b.match.rank || compareCommandMenuItems(a.command, b.command))
    .slice(0, 8)
    .map(({ command: c, match }) => {
      const hint = commandHint(c);
      return {
        key: c.id,
        label: `/${c.name}${hint}`,
        labelMatches: match.labelIndices.map((index) => index + 1),
        hint: c.description,
        typeBadge: c.type === 'skill' ? 'Skill' : 'Command',
        icon: c.type === 'skill' ? c.icon : undefined,
        version: c.type === 'skill' ? c.version : undefined,
        badge: itemBadge(c, t),
        insert: `/${c.id} `,
        replace,
        section: commandSection(c),
        executeOnSelect: c.type === 'action' && c.source === 'builtin' && !hint && !c.subcommands?.length
      };
    });
}

function buildInlineSkillSuggestions({
  commands,
  input,
  match,
  t
}: {
  commands: CommandItem[];
  input: string;
  match: RegExpExecArray;
  t: TFn;
}): SessionCommandMenuItem[] {
  const q = (match[2] ?? '').toLowerCase();
  const start = (match.index ?? 0) + (match[1]?.length ?? 0);
  return commands
    .map((c) => {
      if (!c.enabled || c.type !== 'skill') return null;
      const commandMatch = bestCommandMatch(c, q);
      return commandMatch ? { command: c, match: commandMatch } : null;
    })
    .filter((item): item is { command: CommandItem; match: FuzzyMatch & { labelIndices: number[] } } => Boolean(item))
    .toSorted((a, b) => a.match.rank - b.match.rank || compareCommandMenuItems(a.command, b.command))
    .slice(0, 8)
    .map(({ command: c, match: commandMatch }) => ({
      key: c.id,
      label: `/${c.name}`,
      labelMatches: commandMatch.labelIndices.map((index) => index + 1),
      hint: c.description,
      typeBadge: 'Skill',
      icon: c.icon,
      version: c.version,
      badge: itemBadge(c, t),
      insert: `/${c.id} `,
      section: 'Skills',
      replace: { start, end: input.length }
    }));
}

function buildCommandArgumentPhaseSuggestions({
  commands,
  match,
  profiles,
  replace,
  sessions
}: {
  commands: CommandItem[];
  match: RegExpExecArray;
  profiles: CommandMenuProfile[];
  replace: CommandReplaceRange;
  sessions: Session[];
}): SessionCommandMenuItem[] {
  const commandId = match[1] ?? '';
  const command = commands.find((c) => c.enabled && (c.id === commandId || c.aliases.includes(commandId)));
  const rest = match[2];
  if (!command || rest === undefined) return [];

  if (command.subcommands?.length) {
    return buildSubcommandSuggestions({ command, profiles, replace, rest, sessions });
  }

  return buildArgSuggestions({ args: command.args, baseInsert: `/${command.id}`, profiles, replace, rest, sessions });
}

function buildSubcommandSuggestions({
  command,
  profiles,
  replace,
  rest,
  sessions
}: {
  command: CommandItem;
  profiles: CommandMenuProfile[];
  replace: CommandReplaceRange;
  rest: string;
  sessions: Session[];
}): SessionCommandMenuItem[] {
  const trimmedRest = rest.trimStart();
  const subToken = trimmedRest.split(/\s+/)[0] ?? '';
  const hasSubcommandBoundary = /\s/.test(trimmedRest);
  const sub = command.subcommands?.find((s) => s.id === subToken || (s.aliases ?? []).includes(subToken));
  if (sub && hasSubcommandBoundary) {
    const subRest = trimmedRest.slice(subToken.length).trimStart();
    return buildArgSuggestions({
      args: sub.args,
      baseInsert: `/${command.id} ${sub.id}`,
      profiles,
      replace,
      rest: subRest,
      sessions
    });
  }
  return (command.subcommands ?? [])
    .map((subcommand) => {
      const q = subToken.toLowerCase();
      const nameMatch = bestLabelMatch(subcommand.name, q);
      const idMatch = bestLabelMatch(subcommand.id, q);
      const match = !idMatch || (nameMatch && nameMatch.rank <= idMatch.rank) ? nameMatch : idMatch;
      return match ? { match, subcommand } : null;
    })
    .filter((item): item is { match: FuzzyMatch; subcommand: NonNullable<CommandItem['subcommands']>[number] } =>
      Boolean(item)
    )
    .toSorted((a, b) => a.match.rank - b.match.rank || a.subcommand.name.localeCompare(b.subcommand.name))
    .slice(0, 8)
    .map(({ match, subcommand }) => ({
      key: `${command.id}:${subcommand.id}`,
      label: subcommand.name,
      labelMatches: match.indices,
      hint: subcommand.description,
      typeBadge: 'Subcommand',
      badge: subcommand.shortcut ? `/${subcommand.shortcut}` : undefined,
      insert: `/${command.id} ${subcommand.id} `,
      replace
    }));
}

function positionalArgState(rest: string): { committed: string[]; hasBoundary: boolean; prefix: string } {
  const hasBoundary = /\s/.test(rest);
  const hasTrailingSpace = /\s$/.test(rest);
  const tokens = rest.trim().length ? rest.trim().split(/\s+/) : [];
  return {
    committed: hasTrailingSpace ? tokens : tokens.slice(0, -1),
    hasBoundary,
    prefix: hasTrailingSpace ? '' : (tokens.at(-1) ?? '')
  };
}

function buildArgSuggestions({
  args,
  baseInsert,
  profiles,
  replace,
  rest,
  sessions
}: {
  args: CommandItem['args'];
  baseInsert: string;
  profiles: CommandMenuProfile[];
  replace: CommandReplaceRange;
  rest: string;
  sessions: Session[];
}): SessionCommandMenuItem[] {
  if (!args?.length) return [];
  const state = positionalArgState(rest);
  const arg = args[state.committed.length] ?? (args.at(-1)?.repeated ? args.at(-1) : undefined);
  if (!arg) return [];
  const prefix = state.prefix.toLowerCase();
  const insertPrefix = [baseInsert, ...state.committed].join(' ');
  const insertValue = (value: string) => `${insertPrefix} ${value}`.trim();

  if (arg.type === 'enum') {
    return (arg.values ?? [])
      .map((value) => {
        const label = value.name ?? value.id;
        const labelMatch = bestLabelMatch(label, prefix);
        const idMatch = bestLabelMatch(value.id, prefix);
        const match = !idMatch || (labelMatch && labelMatch.rank <= idMatch.rank) ? labelMatch : idMatch;
        return match ? { match, value } : null;
      })
      .filter(
        (
          item
        ): item is {
          match: FuzzyMatch;
          value: NonNullable<NonNullable<CommandItem['args']>[number]['values']>[number];
        } => Boolean(item)
      )
      .toSorted(
        (a, b) => a.match.rank - b.match.rank || (a.value.name ?? a.value.id).localeCompare(b.value.name ?? b.value.id)
      )
      .slice(0, 8)
      .map(({ match, value }) => ({
        key: value.id,
        label: value.name ?? value.id,
        labelMatches: match.indices,
        hint: value.description,
        insert: insertValue(value.id),
        replace,
        dismissAfter: true
      }));
  }
  if (arg.type === 'model') {
    return profiles
      .map((profile) => {
        const match = bestLabelMatch(profile.alias, prefix);
        return match ? { match, profile } : null;
      })
      .filter((item): item is { match: FuzzyMatch; profile: CommandMenuProfile } => Boolean(item))
      .toSorted((a, b) => a.match.rank - b.match.rank || a.profile.alias.localeCompare(b.profile.alias))
      .slice(0, 8)
      .map(({ match, profile }) => ({
        key: profile.alias,
        label: profile.alias,
        labelMatches: match.indices,
        hint: `${profile.routes.chat.provider}:${profile.routes.chat.modelId}`,
        insert: insertValue(profile.alias),
        replace,
        dismissAfter: true
      }));
  }
  if (arg.type === 'session') {
    return sessions
      .map((session) => {
        const match = bestLabelMatch(session.title, prefix);
        return match ? { match, session } : null;
      })
      .filter((item): item is { match: FuzzyMatch; session: Session } => Boolean(item))
      .toSorted((a, b) => a.match.rank - b.match.rank || a.session.title.localeCompare(b.session.title))
      .slice(0, 8)
      .map(({ session }, index) => ({
        key: session.id,
        label: String(index + 1),
        hint: session.title,
        insert: insertValue(String(index + 1)),
        replace,
        dismissAfter: true
      }));
  }
  return [];
}
