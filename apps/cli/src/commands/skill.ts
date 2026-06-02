import type { MonadClient } from '@monad/client';
import type {
  CreateSkillResponse,
  InstallSkillResponse,
  ListInstalledSkillsResponse,
  ListSkillsResponse,
  OkResponse,
  SearchSkillsResponse,
  ValidateSkillsResponse
} from '@monad/protocol';
import type { CommandDef } from './types.ts';

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, green, json, out, red, yellow } from '../lib/output.ts';

const SKILL_LIST_SCOPES = ['runtime', 'global', 'atom-pack', 'agent'] as const;
type SkillListScope = (typeof SKILL_LIST_SCOPES)[number];

function requireTreatyData<T>(result: { data: T | null; status: number }): T {
  if (result.data === null) throw new Error(`request failed: ${result.status}`);
  return result.data;
}

/** Remove a personal-scope skill (~/.monad/skills/<name>) via the daemon (it hot-reloads). */
async function remove(name: string | undefined, client: MonadClient): Promise<void> {
  if (!name) {
    out(t('cli.skills.usage'));
    return;
  }
  try {
    requireTreatyData<OkResponse>(await client.treaty.v1.atoms.skills({ name }).delete());
    out(`${green(t('cli.skills.removed'))} ${cyan(name)}`);
  } catch (err) {
    out(red(`✗ ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
  }
}

/** Scaffold a new skill from a template via the daemon (it validates + hot-reloads). */
async function scaffold(name: string | undefined, client: MonadClient): Promise<void> {
  if (!name) {
    out(t('cli.skills.usage'));
    return;
  }
  const content = [
    '---',
    `name: ${name}`,
    'description: TODO — what this skill does and when the agent should use it.',
    '---',
    '',
    'TODO: step-by-step instructions for the agent.',
    ''
  ].join('\n');
  try {
    const created = requireTreatyData<CreateSkillResponse>(await client.treaty.v1.atoms.skills.post({ name, content }));
    out(`${green(t('cli.skills.created'))} ${cyan(join(created.dir, 'SKILL.md'))}`);
    for (const w of created.warnings) out(`${yellow('!')} ${yellow(w)}`);
    out(dim(t('cli.skills.editThenValidate')));
  } catch (err) {
    out(red(`✗ ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
  }
}

function sourceKind(source?: string): string | null {
  if (!source) return null;
  if (source.startsWith('git+')) return 'git';
  if (source.startsWith('https://') || source.startsWith('http://')) return 'http';
  if (source.startsWith('github:')) return 'github';
  if (source.startsWith('clawhub:') || (!source.includes(':') && !source.startsWith('/') && !source.startsWith('.')))
    return 'clawhub';
  return null;
}

/** Map a source spec to a git clone URL, or null if it's a local path. */
function gitUrlFor(source: string): string | null {
  if (source.startsWith('git:')) {
    const ref = source.slice(4);
    return /^(https?:|git@)/.test(ref) ? ref : `https://github.com/${ref}.git`;
  }
  if (/^https?:\/\/.+\.git$/.test(source) || source.startsWith('git@')) return source;
  // `owner/repo` shorthand — only when it isn't an existing local path.
  if (/^[\w.-]+\/[\w.-]+$/.test(source) && !existsSync(source)) return `https://github.com/${source}.git`;
  return null;
}

/** Parse-validate every skill under `path` via the daemon (it reads the local path). */
async function validate(path: string | undefined, client: MonadClient): Promise<void> {
  if (!path) {
    out(t('cli.skills.usage'));
    return;
  }
  const root = resolve(path);
  const { results } = requireTreatyData<ValidateSkillsResponse>(
    await client.treaty.v1.atoms.skills.validate.post({ path: root })
  );
  if (results.length === 0) {
    out(dim(t('cli.skills.noMdUnder', { root })));
    return;
  }
  for (const r of results) {
    if (r.ok) {
      out(`${green('✓')} ${cyan(r.name)}  ${dim(r.dir)}`);
      for (const w of r.warnings) out(`  ${yellow('!')} ${yellow(w)}`);
    } else out(`${red('✗')} ${r.name}  ${red(r.error ?? '')}`);
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

/** Install skill(s) from a local path or a git repo. Git sources are cloned to a tmp dir, then the
 *  daemon reads + installs from the local path (it owns ~/.monad/skills and hot-reloads). */
async function install(source: string | undefined, client: MonadClient): Promise<void> {
  if (!source) {
    out(t('cli.skills.usage'));
    return;
  }
  const gitUrl = gitUrlFor(source);
  let srcRoot = resolve(source);
  let cleanup: (() => Promise<void>) | undefined;

  if (gitUrl) {
    const tmp = await mkdtemp(join(tmpdir(), 'monad-skill-install-'));
    cleanup = () => rm(tmp, { recursive: true, force: true });
    try {
      await Bun.$`git clone --depth 1 ${gitUrl} ${tmp}`.quiet();
    } catch {
      await cleanup();
      out(red(t('cli.skills.cloneFailed', { url: gitUrl })));
      process.exitCode = 1;
      return;
    }
    srcRoot = tmp;
  }

  try {
    const res = requireTreatyData<InstallSkillResponse>(
      await client.treaty.v1.atoms.skills.local.post({ path: srcRoot, overwrite: false })
    );
    if (res.skills.length === 0 && res.warnings.length === 0) {
      out(red(t('cli.skills.noMdIn', { source })));
      process.exitCode = 1;
      return;
    }
    for (const n of res.skills) out(`${green(t('cli.skills.installed'))} ${cyan(n)}`);
    for (const w of res.warnings) out(`${red('✗')} ${red(w)}`);
    if (res.skills.length > 0) out(dim(t('cli.skills.hotReload')));
  } finally {
    await cleanup?.();
  }
}

async function search(query: string | undefined, client: MonadClient): Promise<void> {
  if (!query) {
    out(t('cli.skills.usage'));
    return;
  }
  const { results } = requireTreatyData<SearchSkillsResponse>(
    await client.treaty.v1.skills.search.get({ query: { q: query } })
  );
  if (results.length === 0) {
    out(dim(`No skills found for "${query}"`));
    return;
  }
  for (const r of results) {
    const score = r.score != null ? dim(` (score: ${r.score.toFixed(2)})`) : '';
    const dl = r.downloads != null ? dim(` · ${r.downloads} installs`) : '';
    out(`  ${cyan(r.id)}${score}${dl}`);
    out(`    ${r.description}`);
    out(dim(`    monad skill install clawhub:${r.id}`));
    out('');
  }
}

export const command: CommandDef = {
  name: 'skill',
  synopsis: 'skill <list|search|install|remove|new|validate> [arg]',
  description: 'manage skills (list, search, install, remove, new, validate)',
  descriptionKey: 'cli.cmd.skill.desc',
  flags: {
    scope: { type: 'string', description: 'list scope: runtime | global | atom-pack | agent' }
  },
  async run({ positionals: args, flags, globals, client }) {
    const [sub, target] = args;
    // `github:` / `clawhub:` / bare names → daemon (tarball fetch, lockfile, hot-reload).
    // Raw git URLs and local paths stay as the offline clone+copy path.
    const isDaemonRef =
      target?.startsWith('github:') ||
      target?.startsWith('clawhub:') ||
      target?.startsWith('git+') ||
      target?.startsWith('https://') ||
      target?.startsWith('http://') ||
      (!!target && !target.includes(':') && !target.startsWith('/') && !target.startsWith('.'));
    if (sub === 'install' && isDaemonRef) {
      const res = requireTreatyData<InstallSkillResponse>(
        await client.treaty.v1.atoms.skills.install.post({
          source: target ?? '',
          consent: globals.yes === true,
          overwrite: true // a re-install of the same skill updates it in place
        })
      );
      if (res.warnings.length > 0) out(`${yellow(t('cli.atom.scan'))} ${res.warnings.join('; ')}`);
      if (res.needsConsent) {
        out(yellow(t('cli.atom.requests', { name: (res.skills.join(', ') || target) ?? '' })));
        out(dim(t('cli.atom.consentHint')));
        return;
      }
      for (const n of res.skills) out(`${green(t('cli.skills.installed'))} ${cyan(n)}`);
      if (res.skills.length > 0) out(dim(t('cli.skills.hotReload')));
      return;
    }
    if (sub === 'update' && target) {
      const res = requireTreatyData<InstallSkillResponse>(
        await client.treaty.v1.atoms.skills({ name: target }).update.post({ consent: globals.yes === true })
      );
      if (res.warnings.length > 0) out(`${yellow(t('cli.atom.scan'))} ${res.warnings.join('; ')}`);
      if (res.needsConsent) {
        out(yellow(t('cli.atom.requests', { name: res.skills.join(', ') || target })));
        out(dim(t('cli.atom.consentHint')));
        return;
      }
      for (const n of res.skills) out(`${green(t('cli.skills.installed'))} ${cyan(n)}`);
      if (res.skills.length > 0) out(dim(t('cli.skills.hotReload')));
      return;
    }
    if (sub === 'search') return search(target, client);
    if (sub === 'new') return scaffold(target, client);
    if (sub === 'validate') return validate(target, client);
    if (sub === 'install') return install(target, client);
    if (sub === 'remove') return remove(target, client);
    if (sub && sub !== 'list') {
      out(t('cli.skills.usage'));
      return;
    }

    let scope: SkillListScope = 'runtime';
    if (flags?.scope !== undefined) {
      const candidate = String(flags.scope);
      if (!SKILL_LIST_SCOPES.includes(candidate as SkillListScope)) {
        throw new Error(`invalid --scope ${candidate} (expected one of: ${SKILL_LIST_SCOPES.join(', ')})`);
      }
      scope = candidate as SkillListScope;
    }

    const [{ skills }, { skills: installed }] = await Promise.all([
      requireTreatyData<ListSkillsResponse>(await client.treaty.v1.skills.get({ query: { scope } })),
      requireTreatyData<ListInstalledSkillsResponse>(await client.treaty.v1.atoms.skills.get())
    ]);
    json(skills);
    if (skills.length === 0) {
      out(dim(t('cli.skills.none')));
      return;
    }
    const sourceMap = new Map(installed.map((s) => [s.name, s.source]));
    out(bold(t('cli.skills.count', { count: skills.length })));
    for (const s of skills) {
      const tag = !s.available
        ? red(t('cli.skills.unavailable', { list: (s.unavailable ?? []).join(', ') }))
        : s.userInvocable
          ? ''
          : dim(t('cli.skills.modelOnly'));
      const kind = sourceKind(sourceMap.get(s.name));
      const srcBadge = kind ? ` ${dim(`[${kind}]`)}` : '';
      out(`  ${cyan(`/${s.name}`)}${srcBadge}${tag}  ${dim(s.description)}`);
    }
  }
};
