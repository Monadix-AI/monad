// Skill subsystem: discover skills (personal + workspace), map them to the agent's L1 view + the
// skills.list view, and keep both live across hot-reload. Encapsulates the closures and the two
// in-place arrays (loadedSkills/skillList) that the live `skill` tool and skills.list RPC read, so
// the runtime assembly just consumes the returned handles.

import type { MonadPaths } from '@monad/home';
import type { AtomConflict, SkillListInstance, SkillListItem } from '@monad/protocol';
import type { LoadedSkill } from '#/agent/index.ts';
import type { WatchSource } from '#/infra/watch-service.ts';
import type { ResolvedSkillState, Skill, SkillCollision, SkillStateRef } from '#/store/home/skills.ts';

import { readdir } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { logger } from '@monad/logger';

import { renderShellInjections } from '#/agent/index.ts';
import { shellArgv } from '#/capabilities/tools';
import { daemonChildProcesses, killDaemonProcessTree } from '#/infra/daemon-child-processes.ts';
import { checkSkillCompatibility, SkillRegistry, skillEligibility, skillPathsMatch } from '#/store/home/skills.ts';

/** Conventional project-local monad directory (analogous to `.git`). */
const PROJECT_LOCAL_DIR = '.monad';

export interface SkillSubsystem {
  /** L1 skill views fed to the agent — mutated IN PLACE on reload so the live agent reflects edits. */
  loadedSkills: LoadedSkill[];
  /** skills.list view — mutated IN PLACE on reload alongside loadedSkills. */
  skillList: SkillListItem[];
  /** Management view containing every discovered source, including shadowed same-name skills. */
  skillInstances: SkillListInstance[];
  /** Bare-name collisions across skill sources — mutated in place on reload. Surfaced through the
   *  daemon's conflict list as diagnostics; runtime dispatch uses addressable instance ids. */
  skillCollisions: AtomConflict[];
  /** Discover `cwd/.monad/skills/` for a newly-created session (best-effort, errors swallowed). */
  discoverProjectSkills(cwd: string): Promise<LoadedSkill[]>;
  /** Re-discover + re-map all skills, updating loadedSkills/skillList in place. */
  reloadSkills(): Promise<void>;
}

export interface SkillWatchRegistrar {
  register(source: WatchSource): boolean;
}

export async function createSkillSubsystem(deps: {
  paths: MonadPaths;
  watchService: SkillWatchRegistrar;
  monadVersion: string;
  /** Live skill-state resolver. Passed as a function so config hot-reload reassignment is seen. */
  skillState: (skill: SkillStateRef) => ResolvedSkillState;
}): Promise<SkillSubsystem> {
  const { paths, watchService, monadVersion, skillState } = deps;

  // Discovery order is stable for diagnostics and UI grouping only. Runtime dispatch does not let
  // later same-name skills shadow earlier ones; every instance is addressed by its source-qualified id.
  const workspaceSkillsDir = join(paths.workspace, 'skills');
  let atomPackSkillDirs: string[] = [];
  try {
    const entries = await readdir(paths.packs, { withFileTypes: true });
    atomPackSkillDirs = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => join(paths.packs, e.name, 'skills'));
  } catch {
    // packs dir absent — no atom pack skills
  }
  const skillSourceDirs = [...atomPackSkillDirs, paths.skills, workspaceSkillsDir];
  const skillRegistry = new SkillRegistry();
  const discoveredSkills = await skillRegistry.discoverMany(skillSourceDirs);
  if (discoveredSkills.errors.length > 0) {
    for (const e of discoveredSkills.errors) {
      logger.warn(`monad: skill "${e.skill}" failed to load: ${e.error}`);
    }
  }

  const eligibilityCtx = {
    hasBin: (name: string) => Bun.which(name) !== null,
    env: Bun.env as Record<string, string | undefined>,
    platform: process.platform as string
  };

  const sourceMeta = (skillDir: string): { kind: SkillListInstance['sourceKind']; id: string } => {
    const sourceDir = dirname(skillDir);
    if (sourceDir === paths.skills) return { kind: 'global', id: 'global' };

    if (sourceDir.startsWith(`${paths.packs}${sep}`) && basename(sourceDir) === 'skills') {
      return { kind: 'atom-pack', id: `atom-pack:${basename(dirname(sourceDir))}` };
    }

    if (sourceDir.startsWith(`${paths.agents}${sep}`) && basename(sourceDir) === 'skills') {
      return { kind: 'agent', id: `agent:${basename(dirname(sourceDir))}` };
    }

    return { kind: 'agent', id: 'agent:project' };
  };
  const skillInstanceId = (s: Skill): string => `${sourceMeta(s.dir).id}:${s.name}`;

  const mapSkill = (
    s: Skill,
    opts: { warnCompatibility?: boolean } = {}
  ): { loaded: LoadedSkill; listItem: SkillListItem } => {
    const elig = skillEligibility(s.requires, eligibilityCtx);
    const state = skillState({ id: skillInstanceId(s), name: s.name });
    const userInvocable = elig.ok && state.enabled && s.userInvocable !== false;
    // Advisory compatibility: surfaced to the user, never blocks. We only warn when it reads as a
    // semver range the running version fails (and we actually know our version).
    const compat = checkSkillCompatibility(s.compatibility, monadVersion);
    if (opts.warnCompatibility && compat && !compat.compatible && monadVersion !== '0.0.0') {
      logger.warn(
        `monad: skill "${s.name}" wants monad ${compat.requirement} but this is ${monadVersion} — loaded anyway (override)`
      );
    }
    const loaded: LoadedSkill = {
      name: skillInstanceId(s),
      description: s.description,
      version: s.version,
      icon: s.icon,
      body: s.body,
      dir: s.dir,
      allowedTools: s.allowedTools,
      fork: s.context === 'fork',
      tier: s.tier,
      modelInvocable: elig.ok && !s.disableModelInvocation && state.autoload,
      userInvocable
    };
    const listItem: SkillListItem = {
      name: skillInstanceId(s),
      description: s.description,
      ...(s.version ? { version: s.version } : {}),
      ...(s.icon ? { icon: s.icon } : {}),
      userInvocable,
      available: elig.ok,
      ...(elig.ok ? {} : { unavailable: elig.missing }),
      // Surface the tier only for fork skills (it's meaningless without `context: fork`).
      ...(s.context === 'fork' && s.tier ? { tier: s.tier } : {}),
      // Advisory compatibility requirement (non-blocking) — clients show it as a note.
      ...(s.compatibility ? { compatibility: s.compatibility } : {})
    };
    return { loaded, listItem };
  };

  // Opt-in dynamic context: render `!`cmd`` placeholders in skill bodies by running them in
  // a shell. OFF by default — arbitrary shell from a SKILL.md is a real escalation, so the
  // operator must explicitly enable it. Each command has a 5s render budget; failures become
  // a visible marker (see renderShellInjections). Runs at load and on every hot-reload.
  const SKILLS_SHELL_EXEC = process.argv.includes('--skills-shell-exec');
  if (SKILLS_SHELL_EXEC) logger.warn('monad: --skills-shell-exec — skills may run shell commands at load time');
  const skillShellRunner = async (cmd: string): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    let exited = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), 5000);
    });
    try {
      proc = Bun.spawn(shellArgv(cmd), { stdout: 'pipe', stderr: 'pipe', detached: true });
      daemonChildProcesses.track(proc.pid, 'skills-shell-exec');
      void proc.exited.then(() => {
        exited = true;
        daemonChildProcesses.untrack(proc?.pid);
      });
      return await Promise.race([new Response(proc.stdout as ReadableStream<Uint8Array>).text(), timeout]);
    } finally {
      clearTimeout(timer); // whichever branch wins, don't leave the timeout armed
      if (proc && !exited) {
        killDaemonProcessTree(proc.pid);
        daemonChildProcesses.untrack(proc.pid);
      }
    }
  };
  const buildSkillViews = async (
    allInstances: Skill[]
  ): Promise<{ loaded: LoadedSkill[]; list: SkillListItem[]; instances: SkillListInstance[] }> => {
    const mapped = allInstances.map((s) => mapSkill(s, { warnCompatibility: true }));
    if (SKILLS_SHELL_EXEC) {
      await Promise.all(
        mapped.map(async (m) => {
          m.loaded.body = await renderShellInjections(m.loaded.body, skillShellRunner);
        })
      );
    }
    // `paths` activation: an otherwise-auto-loaded skill that declares globs only enters L1 when
    // the workspace currently has a matching file. Evaluated against workspace state at (re)build
    // time. `/name` invocation is unaffected (paths gate L1 auto-load only).
    await Promise.all(
      mapped.map(async (m, i) => {
        const globs = allInstances[i]?.paths;
        if (m.loaded.modelInvocable && globs?.length && !(await skillPathsMatch(globs, paths.workspace))) {
          m.loaded.modelInvocable = false;
        }
      })
    );
    const instances = allInstances.map((s, i) => {
      const source = sourceMeta(s.dir);
      const item = mapped[i] ?? mapSkill(s);
      return {
        ...item.listItem,
        name: s.name,
        id: skillInstanceId(s),
        sourceKind: source.kind,
        sourceId: source.id,
        source: source.id,
        active: (item.loaded.modelInvocable !== false || item.listItem.userInvocable) && item.listItem.available
      };
    });
    return { loaded: mapped.map((m) => m.loaded), list: mapped.map((m) => m.listItem), instances };
  };
  const initialViews = await buildSkillViews(skillRegistry.allInstances());
  const loadedSkills = initialViews.loaded;
  const skillList: SkillListItem[] = initialViews.list;
  const skillInstances: SkillListInstance[] = initialViews.instances;

  const toConflicts = (cols: SkillCollision[]): AtomConflict[] =>
    cols.map((c) => ({
      kind: 'skill',
      bareId: c.name,
      winner: sourceMeta(join(c.winnerDir, c.name)).id,
      shadowed: c.shadowedDirs.map((dir) => sourceMeta(join(dir, c.name)).id)
    }));
  const skillCollisions: AtomConflict[] = toConflicts(discoveredSkills.collisions);

  // Update both arrays IN PLACE so the live `skill` tool and skills.list RPC reflect edits
  // without a restart. Adding the very first skill to an empty daemon still needs a restart —
  // the `skill` tool is only mounted when ≥1 model-invocable skill exists at boot.
  const reloadSkills = async (): Promise<void> => {
    let freshAtomPackSkillDirs: string[] = [];
    try {
      const entries = await readdir(paths.packs, { withFileTypes: true });
      freshAtomPackSkillDirs = entries
        .filter((e) => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => join(paths.packs, e.name, 'skills'));
    } catch {}
    const fresh = new SkillRegistry();
    const res = await fresh.discoverMany([...freshAtomPackSkillDirs, paths.skills, workspaceSkillsDir]);
    for (const e of res.errors) logger.warn(`monad: skill "${e.skill}" failed to reload: ${e.error}`);
    const next = await buildSkillViews(fresh.allInstances());
    loadedSkills.splice(0, loadedSkills.length, ...next.loaded);
    skillList.splice(0, skillList.length, ...next.list);
    skillInstances.splice(0, skillInstances.length, ...next.instances);
    skillCollisions.splice(0, skillCollisions.length, ...toConflicts(res.collisions));
  };
  watchService.register({ name: 'skills', path: paths.skills, recursive: true, onChange: reloadSkills });
  watchService.register({
    name: 'workspace-skills',
    path: workspaceSkillsDir,
    recursive: true,
    onChange: reloadSkills
  });

  // Load skills from `cwd/.monad/skills/` for a newly-created session. Errors during discovery
  // (non-existent dir, bad SKILL.md) are silently swallowed — project skills are best-effort.
  const discoverProjectSkills = async (cwd: string): Promise<LoadedSkill[]> => {
    const dir = join(cwd, PROJECT_LOCAL_DIR, 'skills');
    const reg = new SkillRegistry();
    await reg.discover(dir);
    if (!reg.all().length) return [];
    const views = await buildSkillViews(reg.allInstances());
    return views.loaded;
  };

  return { loadedSkills, skillList, skillInstances, skillCollisions, discoverProjectSkills, reloadSkills };
}
