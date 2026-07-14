import type { HookEvent, WorkspaceExperiencePermission } from '@monad/protocol';
import type {
  Connector,
  ExperienceWorker,
  HookDefinition,
  WorkspaceExperienceApi,
  WorkspaceExperienceApiHandler,
  WorkspaceExperienceDefinition
} from '@monad/sdk-atom';
import type { Tool } from '#/capabilities/tools/types.ts';

export interface RegisteredWorkspaceExperience extends WorkspaceExperienceDefinition {
  atomPackId?: string;
}

export interface RegisteredWorkspaceExperienceApiRoute {
  atomPackId?: string;
  experienceId: string;
  handler: WorkspaceExperienceApiHandler;
  method: string;
  path: string;
  permissions: readonly WorkspaceExperiencePermission[];
}

export interface RegisteredExperienceWorker {
  atomPackId: string;
  permissions: readonly WorkspaceExperiencePermission[];
  worker: ExperienceWorker;
}

/** Collects tools/connectors/hooks registered by loaded atom packs — the daemon's host sink for the
 *  `tool`/`connector`/`hook` atom kinds (see createChannelRegistry). */
export class AtomPackRegistry {
  readonly tools = new Map<string, Tool>();
  readonly connectors = new Map<string, Connector>();
  readonly hooks = new Map<HookEvent, HookDefinition[]>();
  readonly workspaceExperiences = new Map<string, RegisteredWorkspaceExperience>();
  readonly workspaceExperienceApiRoutes = new Map<string, RegisteredWorkspaceExperienceApiRoute>();
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

  registerConnector(connector: Connector): void {
    this.connectors.set(connector.name, connector);
  }

  registerHook(hook: HookDefinition): void {
    const list = this.hooks.get(hook.event) ?? [];
    list.push(hook);
    this.hooks.set(hook.event, list);
  }

  registerWorkspaceExperience(experience: WorkspaceExperienceDefinition, atomPackId?: string): void {
    if (experience.entry.type === 'host-component' && atomPackId !== 'monad-builtins') {
      const next = atomPackId ?? 'builtin';
      throw new Error(`workspace experience "${experience.id}" from "${next}" uses host-only component entry`);
    }
    const existing = this.workspaceExperiences.get(experience.id);
    if (existing) {
      const current = existing.atomPackId ?? 'builtin';
      const next = atomPackId ?? 'builtin';
      throw new Error(
        `duplicate workspace experience id "${experience.id}" from "${next}" already registered by "${current}"`
      );
    }
    this.workspaceExperiences.set(experience.id, { ...experience, ...(atomPackId ? { atomPackId } : {}) });
  }

  registerWorkspaceExperienceApi(
    api: WorkspaceExperienceApi,
    atomPackId?: string,
    permissions: readonly WorkspaceExperiencePermission[] = []
  ): void {
    const experience = this.workspaceExperiences.get(api.experienceId);
    if (!experience) {
      throw new Error(`unknown workspace experience id "${api.experienceId}"`);
    }
    for (const route of api.routes) {
      const normalized = normalizeWorkspaceExperienceApiRoute(route.method, route.path);
      if (experience.atomPackId !== atomPackId) {
        const owner = experience.atomPackId ?? 'builtin';
        const next = atomPackId ?? 'builtin';
        throw new Error(
          `workspace experience API route "${normalized.method} ${normalized.path}" for "${api.experienceId}" from "${next}" is not owned by "${owner}"`
        );
      }
      const existing = this.workspaceExperienceApiRoutes.get(`${api.experienceId}:${normalized.key}`);
      if (existing) {
        const current = existing.atomPackId ?? 'builtin';
        const next = atomPackId ?? 'builtin';
        throw new Error(
          `duplicate workspace experience API route "${route.method} ${route.path}" for "${api.experienceId}" from "${next}" already registered by "${current}"`
        );
      }
      this.workspaceExperienceApiRoutes.set(`${api.experienceId}:${normalized.key}`, {
        ...(atomPackId ? { atomPackId } : {}),
        experienceId: api.experienceId,
        handler: route.handle,
        method: normalized.method,
        path: normalized.path,
        permissions
      });
    }
  }

  getWorkspaceExperienceApiHandler(
    experienceId: string,
    method: string,
    path: string
  ): WorkspaceExperienceApiHandler | undefined {
    const normalized = normalizeWorkspaceExperienceApiRoute(method, path);
    return this.workspaceExperienceApiRoutes.get(`${experienceId}:${normalized.key}`)?.handler;
  }

  getWorkspaceExperienceApiRoute(
    experienceId: string,
    method: string,
    path: string
  ): RegisteredWorkspaceExperienceApiRoute | undefined {
    const normalized = normalizeWorkspaceExperienceApiRoute(method, path);
    return this.workspaceExperienceApiRoutes.get(`${experienceId}:${normalized.key}`);
  }

  registerExperienceWorker(
    worker: ExperienceWorker,
    atomPackId: string,
    permissions: readonly WorkspaceExperiencePermission[] = []
  ): void {
    const key = `${atomPackId}:${worker.experienceId}`;
    if (this.experienceWorkers.has(key)) throw new Error(`duplicate experience worker "${key}"`);
    this.experienceWorkers.set(key, { atomPackId, permissions, worker });
  }

  clearWorkspaceExperiences(): void {
    this.workspaceExperiences.clear();
    this.workspaceExperienceApiRoutes.clear();
    this.experienceWorkers.clear();
  }

  /** Drop all registered hooks. Used before a re-discovery sweep so a removed atom pack's hooks
   *  don't linger (the sweep re-adds the surviving packs' hooks). The HookRunner reads this Map
   *  live per event, so the refresh takes effect without a restart. */
  clearHooks(): void {
    this.hooks.clear();
  }
}

function normalizeWorkspaceExperienceApiRoute(
  method: string,
  path: string
): { key: string; method: string; path: string } {
  const upperMethod = method.toUpperCase();
  const pathname = path.startsWith('/') ? path : `/${path}`;
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return { key: `${upperMethod} ${normalizedPath}`, method: upperMethod, path: normalizedPath };
}
