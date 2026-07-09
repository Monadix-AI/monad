import type { CommandItem, ProfileView, Session } from '@monad/protocol';
import type { TFn } from '#/components/I18nProvider';
import type { SessionCommandMenuItem } from './SessionRoute';

export type CommandMenuProfile = ProfileView;

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

// Builds the `/` autocomplete menu: command-name phase, inline-skill phase, subcommand phase, then
// positional argument suggestions from structured command metadata.
export function buildCommandMenuItems(
  input: string,
  commands: CommandItem[],
  profiles: CommandMenuProfile[],
  sessions: Session[],
  t: TFn
): SessionCommandMenuItem[] {
  // Command-name phase: "/", "/re" … — suggest matching commands with their arg hint + source badge.
  const trimmedStart = input.trimStart();
  const nameM = /^\/([^\s]*)$/.exec(trimmedStart);
  if (nameM) {
    const q = (nameM[1] ?? '').toLowerCase();
    return commands
      .filter((c) => {
        if (!c.enabled) return false;
        return c.id.toLowerCase().startsWith(q) || c.name.toLowerCase().startsWith(q);
      })
      .toSorted(compareCommandMenuItems)
      .slice(0, 8)
      .map((c) => {
        const hint = commandHint(c);
        return {
          key: c.id,
          label: `/${c.name}${hint}`,
          hint: c.description,
          typeBadge: c.type === 'skill' ? 'Skill' : 'Command',
          icon: c.type === 'skill' ? c.icon : undefined,
          version: c.type === 'skill' ? c.version : undefined,
          badge: itemBadge(c, t),
          insert: `/${c.id} `,
          section: commandSection(c),
          executeOnSelect: c.type === 'action' && c.source === 'builtin' && !hint && !c.subcommands?.length
        };
      });
  }
  const inlineSkillM = /(^|\s)\/([^\s/]*)$/.exec(input);
  if (inlineSkillM) {
    const q = (inlineSkillM[2] ?? '').toLowerCase();
    const start = (inlineSkillM.index ?? 0) + (inlineSkillM[1]?.length ?? 0);
    return commands
      .filter((c) => {
        if (!c.enabled || c.type !== 'skill') return false;
        return c.id.toLowerCase().startsWith(q) || c.name.toLowerCase().startsWith(q);
      })
      .toSorted(compareCommandMenuItems)
      .slice(0, 8)
      .map((c) => {
        return {
          key: c.id,
          label: `/${c.name}`,
          hint: c.description,
          typeBadge: 'Skill',
          icon: c.icon,
          version: c.version,
          badge: itemBadge(c, t),
          insert: `/${c.id} `,
          section: 'Skills',
          replace: { start, end: input.length }
        };
      });
  }
  const argM = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmedStart);
  if (argM) {
    const commandId = argM[1] ?? '';
    const command = commands.find((c) => c.enabled && (c.id === commandId || c.aliases.includes(commandId)));
    const rest = argM[2];
    if (!command || rest === undefined) return [];

    if (command.subcommands?.length) {
      const trimmedRest = rest.trimStart();
      const subToken = trimmedRest.split(/\s+/)[0] ?? '';
      const hasSubcommandBoundary = /\s/.test(trimmedRest);
      const sub = command.subcommands.find((s) => s.id === subToken || (s.aliases ?? []).includes(subToken));
      if (sub && hasSubcommandBoundary) {
        const subRest = trimmedRest.slice(subToken.length).trimStart();
        return buildArgSuggestions({
          args: sub.args,
          baseInsert: `/${command.id} ${sub.id}`,
          profiles,
          rest: subRest,
          sessions
        });
      }
      return command.subcommands
        .filter((subcommand) => {
          const q = subToken.toLowerCase();
          return subcommand.id.toLowerCase().startsWith(q) || subcommand.name.toLowerCase().startsWith(q);
        })
        .slice(0, 8)
        .map((subcommand) => ({
          key: `${command.id}:${subcommand.id}`,
          label: subcommand.name,
          hint: subcommand.description,
          typeBadge: 'Subcommand',
          badge: subcommand.shortcut ? `/${subcommand.shortcut}` : undefined,
          insert: `/${command.id} ${subcommand.id} `
        }));
    }

    return buildArgSuggestions({ args: command.args, baseInsert: `/${command.id}`, profiles, rest, sessions });
  }
  return [];
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
  rest,
  sessions
}: {
  args: CommandItem['args'];
  baseInsert: string;
  profiles: CommandMenuProfile[];
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
      .filter(
        (value) => value.id.toLowerCase().startsWith(prefix) || (value.name ?? '').toLowerCase().startsWith(prefix)
      )
      .slice(0, 8)
      .map((value) => ({
        key: value.id,
        label: value.name ?? value.id,
        hint: value.description,
        insert: insertValue(value.id),
        dismissAfter: true
      }));
  }
  if (arg.type === 'model') {
    return profiles
      .filter((profile) => profile.alias.toLowerCase().startsWith(prefix))
      .slice(0, 8)
      .map((profile) => ({
        key: profile.alias,
        label: profile.alias,
        hint: `${profile.routes.chat.provider}:${profile.routes.chat.modelId}`,
        insert: insertValue(profile.alias),
        dismissAfter: true
      }));
  }
  if (arg.type === 'session') {
    return sessions
      .filter((session) => session.title.toLowerCase().includes(prefix))
      .slice(0, 8)
      .map((session, index) => ({
        key: session.id,
        label: String(index + 1),
        hint: session.title,
        insert: insertValue(String(index + 1)),
        dismissAfter: true
      }));
  }
  return [];
}
