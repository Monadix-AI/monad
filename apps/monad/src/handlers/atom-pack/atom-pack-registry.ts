import type { HookEvent, WorkplaceExperiencePermission } from '@monad/protocol';
import type {
  ExperienceWorker,
  HookDefinition,
  WorkplaceExperienceApi,
  WorkplaceExperienceApiHandler,
  WorkplaceExperienceDefinition
} from '@monad/sdk-atom';
import type { Tool } from '#/capabilities/tools/types.ts';

import { workplaceExperiencePermissionSchema } from '@monad/protocol';

const BUILTIN_ATOM_PACK_ID = 'monad-builtins';

function isBuiltinAtomPack(atomPackId?: string): boolean {
  return atomPackId === undefined || atomPackId === BUILTIN_ATOM_PACK_ID;
}

export interface RegisteredWorkplaceExperience extends WorkplaceExperienceDefinition {
  atomPackId?: string;
  permissions: WorkplaceExperiencePermission[];
}

export interface RegisteredWorkplaceExperienceApiRoute {
  atomPackId?: string;
  experienceId: string;
  handler: WorkplaceExperienceApiHandler;
  method: string;
  path: string;
  permissions: readonly WorkplaceExperiencePermission[];
}

export interface RegisteredExperienceWorker {
  atomPackId: string;
  permissions: readonly WorkplaceExperiencePermission[];
  worker: ExperienceWorker;
}

/** Collects daemon tools and hooks registered by loaded atom packs. */
export class AtomPackRegistry {
  readonly tools = new Map<string, Tool>();
  readonly hooks = new Map<HookEvent, HookDefinition[]>();
  readonly workplaceExperiences = new Map<string, RegisteredWorkplaceExperience>();
  readonly workplaceExperienceApiRoutes = new Map<string, RegisteredWorkplaceExperienceApiRoute>();
  readonly experienceWorkers = new Map<string, RegisteredExperienceWorker>();
  /** toolName → its source tag, so a rediscovery sweep can drop just the reloadable sources. */
  private readonly toolSources = new Map<string, string>();
  /** toolName → its specific origin name (atom-pack id / MCP server name), for per-agent atom
   *  allowlists (Studio). Distinct from `toolSources` (a coarse reloadable-kind tag); absent for built-ins. */
  private readonly toolSourceNames = new Map<string, string>();
  /** Monotonic tool-set revision + a cached array snapshot, so the agent's per-turn tool getter can
   *  memoize on `toolRevision` and reuse `toolList()`'s reference — no per-turn rebuild when nothing
   *  was installed/removed (the common case). Both are invalidated on any tool-set change. */
  private rev = 0;
  private cachedList: Tool[] | null = null;

  /** Bumps whenever the tool SET changes (install/remove/re-register). */
  get toolRevision(): number {
    return this.rev;
  }

  /** Stable array snapshot — rebuilt only when the set changes, so per-turn reads reuse a reference. */
  toolList(): Tool[] {
    if (this.cachedList === null) this.cachedList = [...this.tools.values()];
    return this.cachedList;
  }

  /** `source` tags where a tool came from so it can be selectively cleared on a rediscovery sweep:
   *  'atom-pack' / 'file-mcp' are re-scanned and cleared; the default 'static' (builtin, config.json
   *  MCP, obscura) is boot-once and never cleared. */
  registerTool(tool: Tool, source = 'static', sourceName?: string): void {
    this.tools.set(tool.name, tool);
    this.toolSources.set(tool.name, source);
    if (sourceName !== undefined) this.toolSourceNames.set(tool.name, sourceName);
    this.rev++;
    this.cachedList = null;
  }

  /** The tool's specific origin name (atom-pack id / MCP server name), or undefined for a built-in.
   *  Used by the per-agent atom allowlist to decide exposure (see Studio `isToolExposed`). */
  sourceNameOf(toolName: string): string | undefined {
    return this.toolSourceNames.get(toolName);
  }

  /** Drop every tool registered under `source` so an UNINSTALLED atom pack / MCP server's tools
   *  don't linger after a rediscovery sweep re-adds only the survivors. The agent reads tools live,
   *  so the removal takes effect on its next turn — no restart. */
  clearToolsFrom(source: string): void {
    let changed = false;
    for (const [name, src] of this.toolSources) {
      if (src !== source) continue;
      this.tools.delete(name);
      this.toolSources.delete(name);
      this.toolSourceNames.delete(name);
      changed = true;
    }
    if (changed) {
      this.rev++;
      this.cachedList = null;
    }
  }

  registerHook(hook: HookDefinition): void {
    const list = this.hooks.get(hook.event) ?? [];
    list.push(hook);
    this.hooks.set(hook.event, list);
  }

  registerWorkplaceExperience(
    experience: WorkplaceExperienceDefinition,
    atomPackId?: string,
    permissions: readonly WorkplaceExperiencePermission[] = []
  ): void {
    if (experience.entry.type === 'host-component' && atomPackId !== BUILTIN_ATOM_PACK_ID) {
      const next = atomPackId ?? 'builtin';
      throw new Error(`workplace experience "${experience.id}" from "${next}" uses host-only component entry`);
    }
    const existing = this.workplaceExperiences.get(experience.id);
    if (existing) {
      const current = existing.atomPackId ?? 'builtin';
      const next = atomPackId ?? 'builtin';
      throw new Error(
        `duplicate workplace experience id "${experience.id}" from "${next}" already registered by "${current}"`
      );
    }
    // The stamped permissions are the manifest's, never the author's: an atom pack that declares
    // `permissions` on its own definition object cannot widen the action surface the Web host grants.
    const stamped: WorkplaceExperiencePermission[] = isBuiltinAtomPack(atomPackId)
      ? [...workplaceExperiencePermissionSchema.options]
      : [...new Set(permissions)];
    this.workplaceExperiences.set(experience.id, {
      ...experience,
      ...(atomPackId ? { atomPackId } : {}),
      permissions: stamped
    });
  }

  registerWorkplaceExperienceApi(
    api: WorkplaceExperienceApi,
    atomPackId?: string,
    permissions: readonly WorkplaceExperiencePermission[] = []
  ): void {
    const experience = this.workplaceExperiences.get(api.experienceId);
    if (!experience) {
      throw new Error(`unknown workplace experience id "${api.experienceId}"`);
    }
    for (const route of api.routes) {
      const normalized = normalizeWorkplaceExperienceApiRoute(route.method, route.path);
      if (experience.atomPackId !== atomPackId) {
        const owner = experience.atomPackId ?? 'builtin';
        const next = atomPackId ?? 'builtin';
        throw new Error(
          `workplace experience API route "${normalized.method} ${normalized.path}" for "${api.experienceId}" from "${next}" is not owned by "${owner}"`
        );
      }
      const existing = this.workplaceExperienceApiRoutes.get(`${api.experienceId}:${normalized.key}`);
      if (existing) {
        const current = existing.atomPackId ?? 'builtin';
        const next = atomPackId ?? 'builtin';
        throw new Error(
          `duplicate workplace experience API route "${route.method} ${route.path}" for "${api.experienceId}" from "${next}" already registered by "${current}"`
        );
      }
      this.workplaceExperienceApiRoutes.set(`${api.experienceId}:${normalized.key}`, {
        ...(atomPackId ? { atomPackId } : {}),
        experienceId: api.experienceId,
        handler: route.handle,
        method: normalized.method,
        path: normalized.path,
        permissions
      });
    }
  }

  getWorkplaceExperienceApiHandler(
    experienceId: string,
    method: string,
    path: string
  ): WorkplaceExperienceApiHandler | undefined {
    const normalized = normalizeWorkplaceExperienceApiRoute(method, path);
    return this.workplaceExperienceApiRoutes.get(`${experienceId}:${normalized.key}`)?.handler;
  }

  getWorkplaceExperienceApiRoute(
    experienceId: string,
    method: string,
    path: string
  ): RegisteredWorkplaceExperienceApiRoute | undefined {
    const normalized = normalizeWorkplaceExperienceApiRoute(method, path);
    return this.workplaceExperienceApiRoutes.get(`${experienceId}:${normalized.key}`);
  }

  registerExperienceWorker(
    worker: ExperienceWorker,
    atomPackId: string,
    permissions: readonly WorkplaceExperiencePermission[] = []
  ): void {
    const key = `${atomPackId}:${worker.experienceId}`;
    if (this.experienceWorkers.has(key)) throw new Error(`duplicate experience worker "${key}"`);
    this.experienceWorkers.set(key, { atomPackId, permissions, worker });
  }

  clearWorkplaceExperiences(): void {
    this.workplaceExperiences.clear();
    this.workplaceExperienceApiRoutes.clear();
    this.experienceWorkers.clear();
  }

  /**
   * Take over the reloadable registrations of a candidate registry built by a rediscovery sweep.
   *
   * Reload is atomic at the pack boundary: the sweep loads every pack into a throwaway registry
   * first, and only a fully-constructed candidate reaches this method. The swap itself is
   * synchronous and cannot fail, so a reader never observes a half-populated registry, and a sweep
   * that throws leaves the previous working set untouched.
   *
   * Tools are deliberately not part of this: they are wired once at startup and no sweep
   * re-registers them.
   */
  adoptReloadableAtoms(candidate: AtomPackRegistry): void {
    this.hooks.clear();
    for (const [event, definitions] of candidate.hooks) this.hooks.set(event, definitions);
    this.workplaceExperiences.clear();
    for (const [id, experience] of candidate.workplaceExperiences) this.workplaceExperiences.set(id, experience);
    this.workplaceExperienceApiRoutes.clear();
    for (const [key, route] of candidate.workplaceExperienceApiRoutes)
      this.workplaceExperienceApiRoutes.set(key, route);
    this.experienceWorkers.clear();
    for (const [key, worker] of candidate.experienceWorkers) this.experienceWorkers.set(key, worker);
  }

  /** Drop all registered hooks. Used before a re-discovery sweep so a removed atom pack's hooks
   *  don't linger (the sweep re-adds the surviving packs' hooks). The HookRunner reads this Map
   *  live per event, so the refresh takes effect without a restart. */
  clearHooks(): void {
    this.hooks.clear();
  }
}

function normalizeWorkplaceExperienceApiRoute(
  method: string,
  path: string
): { key: string; method: string; path: string } {
  const upperMethod = method.toUpperCase();
  const pathname = path.startsWith('/') ? path : `/${path}`;
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return { key: `${upperMethod} ${normalizedPath}`, method: upperMethod, path: normalizedPath };
}
