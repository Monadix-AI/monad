import type { CommandSpec, Session } from '@monad/protocol';
import type { TFn } from '@/components/I18nProvider';
import type { SessionCommandMenuItem } from './SessionRoute';

export type CommandMenuProfile = { alias: string; provider: string; modelId: string };

export function skillCommandDisplayName(name: string): string {
  const parts = name.split(':');
  if (parts.length === 2 && parts[0] === 'global') return parts[1] ?? name;
  if (parts.length === 3 && (parts[0] === 'atom-pack' || parts[0] === 'agent')) return parts[2] ?? name;
  return name;
}

export function skillCommandSource(name: string): { kind: 'global' | 'atom-pack' | 'agent'; name?: string } | null {
  const parts = name.split(':');
  if (parts.length === 2 && parts[0] === 'global') return { kind: 'global' };
  if (parts.length === 3 && parts[0] === 'atom-pack') return { kind: 'atom-pack', name: parts[1] };
  if (parts.length === 3 && parts[0] === 'agent') return { kind: 'agent', name: parts[1] };
  return null;
}

function commandMenuRank(name: string, kind: 'builtin' | 'prompt'): string {
  if (kind !== 'prompt') return `1:${name}`;
  const source = skillCommandSource(name);
  const displayName = skillCommandDisplayName(name);
  const sourceRank = source?.kind === 'global' ? 0 : source?.kind === 'atom-pack' ? 1 : 2;
  return `0:${displayName}:${sourceRank}:${name}`;
}

export function skillCommandMeta(command: CommandSpec | undefined, t: TFn) {
  if (command?.kind !== 'prompt') return null;
  const source = skillCommandSource(command.name);
  return {
    id: command.name,
    label: skillCommandDisplayName(command.name),
    description: command.description,
    icon: command.icon,
    version: command.version,
    sourceLabel:
      source?.kind === 'global'
        ? t('web.skills.sourceGlobal')
        : source?.kind === 'atom-pack'
          ? t('web.skills.sourceAtomPack', { name: source.name ?? '' })
          : source?.kind === 'agent'
            ? t('web.skills.sourceAgent', { name: source.name ?? '' })
            : undefined
  };
}

export function activeSkillToken(
  text: string,
  commands: CommandSpec[],
  t: TFn
): (ReturnType<typeof skillCommandMeta> & { start: number; end: number; raw: string }) | null {
  const token = '[a-z0-9]+(?:-[a-z0-9]+)*';
  const re = new RegExp(`(^|\\s)/(${token}(?::${token}){1,2})(?=\\s|$)`, 'g');
  for (const match of text.matchAll(re)) {
    const id = match[2] as string;
    const command = commands.find((c) => c.kind === 'prompt' && c.name === id);
    const meta = skillCommandMeta(command, t);
    if (!meta) continue;
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return { ...meta, start, end: start + id.length + 1, raw: `/${id}` };
  }
  return null;
}

// Builds the `/` autocomplete menu: command-name phase, inline-skill phase, then argument phase
// (the few enumerable args — `/model <alias>`, `/switch <n>`).
export function buildCommandMenuItems(
  input: string,
  commands: CommandSpec[],
  profiles: CommandMenuProfile[],
  sessions: Session[],
  t: TFn
): SessionCommandMenuItem[] {
  // Command-name phase: "/", "/re" … — suggest matching commands with their arg hint + source badge.
  const nameM = /^\/([^\s]*)$/.exec(input);
  if (nameM) {
    const q = (nameM[1] ?? '').toLowerCase();
    return commands
      .filter((c) => {
        if (!c.available) return false;
        const displayName = c.kind === 'prompt' ? skillCommandDisplayName(c.name) : c.name;
        return c.name.toLowerCase().startsWith(q) || displayName.toLowerCase().startsWith(q);
      })
      .toSorted((a, b) => commandMenuRank(a.name, a.kind).localeCompare(commandMenuRank(b.name, b.kind)))
      .slice(0, 8)
      .map((c) => {
        const displayName = c.kind === 'prompt' ? skillCommandDisplayName(c.name) : c.name;
        const skillSource = c.kind === 'prompt' ? skillCommandSource(c.name) : null;
        return {
          key: c.name,
          label: `/${displayName}${c.argHint ? ` ${c.argHint}` : ''}`,
          hint: c.description,
          typeBadge: c.kind === 'prompt' ? 'Skill' : 'Command',
          icon: c.kind === 'prompt' ? c.icon : undefined,
          version: c.kind === 'prompt' ? c.version : undefined,
          badge:
            c.source === 'atom'
              ? (c.atomName ?? 'atom')
              : skillSource?.kind === 'global'
                ? t('web.skills.sourceGlobal')
                : skillSource?.kind === 'atom-pack'
                  ? t('web.skills.sourceAtomPack', { name: skillSource.name ?? '' })
                  : skillSource?.kind === 'agent'
                    ? t('web.skills.sourceAgent', { name: skillSource.name ?? '' })
                    : undefined,
          insert: `/${c.name} `,
          executeOnSelect: c.kind === 'builtin' && c.source === 'builtin' && !c.argHint
        };
      });
  }
  const inlineSkillM = /(^|\s)\/([^\s/]*)$/.exec(input);
  if (inlineSkillM) {
    const q = (inlineSkillM[2] ?? '').toLowerCase();
    const start = (inlineSkillM.index ?? 0) + (inlineSkillM[1]?.length ?? 0);
    return commands
      .filter((c) => {
        if (!c.available || c.kind !== 'prompt') return false;
        const displayName = skillCommandDisplayName(c.name);
        return c.name.toLowerCase().startsWith(q) || displayName.toLowerCase().startsWith(q);
      })
      .toSorted((a, b) => commandMenuRank(a.name, a.kind).localeCompare(commandMenuRank(b.name, b.kind)))
      .slice(0, 8)
      .map((c) => {
        const displayName = skillCommandDisplayName(c.name);
        const skillSource = skillCommandSource(c.name);
        return {
          key: c.name,
          label: `/${displayName}`,
          hint: c.description,
          typeBadge: 'Skill',
          icon: c.icon,
          version: c.version,
          badge:
            skillSource?.kind === 'global'
              ? t('web.skills.sourceGlobal')
              : skillSource?.kind === 'atom-pack'
                ? t('web.skills.sourceAtomPack', { name: skillSource.name ?? '' })
                : skillSource?.kind === 'agent'
                  ? t('web.skills.sourceAgent', { name: skillSource.name ?? '' })
                  : undefined,
          insert: `/${c.name} `,
          replace: { start, end: input.length }
        };
      });
  }
  // Argument phase: "/model fa", "/switch 2" — suggest argument values for the few enumerable ones.
  const argM = /^\/([a-z0-9-]+)\s+(\S*)$/.exec(input);
  if (argM) {
    const name = argM[1];
    const p = (argM[2] ?? '').toLowerCase();
    if (name === 'model') {
      return profiles
        .filter((pr) => pr.alias.toLowerCase().startsWith(p))
        .slice(0, 8)
        .map((pr) => ({
          key: pr.alias,
          label: pr.alias,
          hint: `${pr.provider}:${pr.modelId}`,
          insert: `/model ${pr.alias}`,
          dismissAfter: true
        }));
    }
    if (name === 'switch') {
      return sessions
        .filter((s) => s.title.toLowerCase().includes(p))
        .slice(0, 8)
        .map((s, i) => ({
          key: s.id,
          label: String(i + 1),
          hint: s.title,
          insert: `/switch ${i + 1}`,
          dismissAfter: true
        }));
    }
  }
  return [];
}
