import type {
  ProjectId,
  SessionOrigin,
  SessionState,
  UpdateWorkplaceProjectRequest,
  WorkplaceProject
} from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { newId } from '@monad/protocol';

import { canTransition } from '#/agent/index.ts';
import { clearProcessesForSession, disposeSandboxSession } from '#/capabilities/tools';
import { HandlerError } from '#/handlers/handler-error.ts';

/** Identity-only origin fields for observability — NEVER the env block (PII). */
function originLog(origin?: SessionOrigin): Record<string, string | undefined> {
  return origin ? { surface: origin.surface, client: origin.client, transport: origin.transport } : {};
}

function projectView(project: WorkplaceProject): WorkplaceProject {
  return {
    id: project.id,
    title: project.title,
    ownerPrincipalId: project.ownerPrincipalId,
    state: project.state,
    archived: project.archived,
    ...(project.model ? { model: project.model } : {}),
    ...(project.cwd ? { cwd: project.cwd } : {}),
    ...(project.origin ? { origin: project.origin } : {}),
    memberTemplates: project.memberTemplates,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
}

/** Workplace project CRUD (list/get/create/update/delete). Extracted from lifecycle.ts as its own
 *  factory — depends on the shared workspace-runtime helpers created once in lifecycle.ts and passed
 *  in so there's a single instance per daemon. */
export function createProjectLifecycleHandlers(
  ctx: SessionContext,
  deps: {
    resolveWorkspaceDir: (cwd: string, base: string | undefined) => string;
  }
) {
  const {
    deps: { store, ownerPrincipalId, sessionSandbox, log }
  } = ctx;
  const { resolveWorkspaceDir } = deps;

  function requireProject(id: ProjectId): WorkplaceProject {
    const project = store.getWorkplaceProject(id);
    if (!project) throw new HandlerError('not_found', `workplace project not found: ${id}`);
    return project;
  }

  return {
    async listProjects(params: { archived?: boolean; state?: SessionState; limit?: number; offset?: number } = {}) {
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;
      const filter = { archived: params.archived, state: params.state };
      return {
        projects: store.listWorkplaceProjects({ ...filter, limit, offset }).map(projectView),
        total: store.countWorkplaceProjects(filter),
        limit,
        offset
      };
    },

    async getProject({ id }: { id: ProjectId }) {
      return { project: projectView(requireProject(id)) };
    },

    async createProject({ title, origin, cwd }: { title: string; origin?: SessionOrigin; cwd?: string }) {
      const resolvedCwd = cwd?.trim() ? resolveWorkspaceDir(cwd, undefined) : undefined;
      const now = new Date().toISOString();
      const project: WorkplaceProject = {
        id: newId('prj'),
        title,
        ownerPrincipalId,
        state: 'active',
        archived: false,
        ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
        ...(origin ? { origin } : {}),
        memberTemplates: [],
        createdAt: now,
        updatedAt: now
      };
      store.insertWorkplaceProject(project);
      await sessionSandbox?.ensure(project.id);
      log?.info({ projectId: project.id, ...originLog(origin) }, 'workplace project created');
      return { projectId: project.id };
    },

    async updateProject({
      id,
      title,
      state,
      archived,
      origin,
      cwd,
      model,
      memberTemplates
    }: { id: ProjectId } & UpdateWorkplaceProjectRequest) {
      const current = requireProject(id);
      if (state !== undefined && !canTransition(current.state, state)) {
        throw new HandlerError('invalid', `illegal state transition: ${current.state} -> ${state}`);
      }
      const resolvedCwd =
        cwd === undefined ? undefined : cwd === null ? null : cwd.trim() ? resolveWorkspaceDir(cwd, current.cwd) : null;
      const project = store.updateWorkplaceProject(id, {
        title,
        state,
        archived,
        model,
        origin,
        memberTemplates,
        ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {})
      });
      if (!project) throw new HandlerError('internal', 'update project failed');
      return { project: projectView(project) };
    },

    async deleteProject({ id }: { id: ProjectId }) {
      requireProject(id);
      clearProcessesForSession(id);
      await sessionSandbox?.dispose(id);
      disposeSandboxSession(id);
      store.deleteWorkplaceProject(id);
      return { deleted: true as const };
    }
  };
}
