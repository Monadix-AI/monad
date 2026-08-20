import type { ProjectMember, Session, SessionBinding, SessionPlanTodo, WorkplaceProject } from '@monad/protocol';
import type { SessionPlanActor, SessionPlanProjectMemberAttribution } from '#/store/db/session-plans.ts';

import { expect, test } from 'bun:test';

import { createStore } from '#/store/db/index.ts';

const createdAt = '2026-07-27T08:00:00.000Z';
const sessionId = 'ses_plan00000001' as const;
const projectId = 'prj_plan00000001' as const;
const otherProjectId = 'prj_plan00000002' as const;
const memberActor: SessionPlanProjectMemberAttribution = {
  source: { surface: 'automation', client: 'managed-agent', instanceId: 'mesh_plan00000001', transport: 'http' },
  projectMemberId: 'pmem_plan_author'
};
const projectMemberActor = {
  kind: 'project_member' as const,
  attribution: { ...memberActor, projectMemberId: 'pmem_plan_author' }
};

function session(id: Session['id'], ownerProjectId?: Session['projectId']): Session {
  return {
    id,
    projectId: ownerProjectId,
    title: id,
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    activityAt: createdAt,
    createdAt,
    updatedAt: createdAt
  };
}

function project(id: WorkplaceProject['id']): WorkplaceProject {
  return {
    id,
    title: id,
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt,
    updatedAt: createdAt
  };
}

function member(id: string, ownerProjectId: WorkplaceProject['id'] = projectId): ProjectMember {
  return {
    id,
    projectId: ownerProjectId,
    profileId: 'codex',
    type: 'mesh-agent',
    displayName: id,
    customPrompt: null,
    launchOverrides: {},
    workingDirectoryOverride: null,
    lifecycle: 'enabled',
    createdAt,
    updatedAt: createdAt
  };
}

function binding(projectMemberId: string): SessionBinding {
  return {
    sessionId,
    projectMemberId,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    currentNativeRuntimeSessionId: null,
    lifecycle: 'active',
    lastHealth: null,
    createdAt,
    updatedAt: createdAt
  };
}

test('managed attribution requires an active binding and assignees must belong to the session project', () => {
  const rootStore = createStore();
  try {
    rootStore.insertSession(session(sessionId));
    rootStore.insertWorkplaceProject(project(projectId));
    rootStore.insertWorkplaceProject(project(otherProjectId));
    rootStore.insertProjectMember(member('pmem_plan_author'));
    rootStore.insertProjectMember(member('pmem_plan_other', otherProjectId));
    rootStore.insertSession(session('ses_planproject1', projectId));
    rootStore.insertSessionBinding({
      ...binding('pmem_plan_author'),
      sessionId: 'ses_planproject1'
    });
    const plans = rootStore.sessionPlans;

    const accepted = plans.addTodo({
      sessionId: 'ses_planproject1',
      requestId: 'idem_planactor001',
      todoId: 'todo_planactor001',
      eventId: 'evt_planactor001',
      text: 'Owned work',
      status: 'pending',
      assigneeProjectMemberId: 'pmem_plan_author',
      actor: projectMemberActor,
      at: createdAt
    });
    rootStore.updateSessionBinding('ses_planproject1', 'pmem_plan_author', {
      lifecycle: 'left',
      updatedAt: '2026-07-27T08:05:00.000Z'
    });
    const rejectedReplayAfterLeave = plans.addTodo({
      sessionId: 'ses_planproject1',
      requestId: 'idem_planactor001',
      todoId: 'todo_planactor001',
      eventId: 'evt_planactor004',
      text: 'Owned work',
      status: 'pending',
      assigneeProjectMemberId: 'pmem_plan_author',
      actor: projectMemberActor,
      at: '2026-07-27T08:05:00.000Z'
    });
    rootStore.updateSessionBinding('ses_planproject1', 'pmem_plan_author', {
      lifecycle: 'active',
      updatedAt: '2026-07-27T08:06:00.000Z'
    });
    const rejectedAssignee = plans.addTodo({
      sessionId: 'ses_planproject1',
      requestId: 'idem_planactor002',
      todoId: 'todo_planactor002',
      eventId: 'evt_planactor002',
      text: 'Cross-project work',
      status: 'pending',
      assigneeProjectMemberId: 'pmem_plan_other',
      actor: projectMemberActor,
      at: createdAt
    });
    const rejectedMissingIdentity = plans.addTodo({
      sessionId: 'ses_planproject1',
      requestId: 'idem_planactor005',
      todoId: 'todo_planactor005',
      eventId: 'evt_planactor005',
      text: 'Anonymous managed mutation',
      status: 'pending',
      actor: {
        kind: 'project_member',
        attribution: {
          source: { surface: 'automation', client: 'managed-agent', transport: 'http' }
        }
      } as SessionPlanActor,
      at: createdAt
    });
    const rejectedActor = plans.addTodo({
      sessionId,
      requestId: 'idem_planactor003',
      todoId: 'todo_planactor003',
      eventId: 'evt_planactor003',
      text: 'Unbound actor',
      status: 'pending',
      actor: projectMemberActor,
      at: createdAt
    });
    const rejectedUnknownActor = plans.addTodo({
      sessionId: 'ses_planproject1',
      requestId: 'idem_planactor006',
      todoId: 'todo_planactor006',
      eventId: 'evt_planactor006',
      text: 'Unknown actor kind',
      status: 'pending',
      actor: {
        kind: 'unknown',
        attribution: memberActor
      } as unknown as SessionPlanActor,
      at: createdAt
    });
    const todo: SessionPlanTodo = {
      id: 'todo_planactor001',
      sessionId: 'ses_planproject1',
      text: 'Owned work',
      status: 'pending',
      assigneeProjectMemberId: 'pmem_plan_author',
      version: 0,
      createdBy: memberActor,
      updatedBy: memberActor,
      createdAt,
      updatedAt: createdAt
    };

    expect({
      accepted,
      rejectedReplayAfterLeave,
      rejectedAssignee,
      rejectedMissingIdentity,
      rejectedActor,
      rejectedUnknownActor,
      projectTodos: plans.listTodos('ses_planproject1').map((todo) => ({
        id: todo.id,
        assigneeProjectMemberId: todo.assigneeProjectMemberId,
        createdBy: todo.createdBy
      })),
      plainPlan: plans.get(sessionId)
    }).toEqual({
      accepted: {
        ok: true,
        replayed: false,
        response: { todo },
        event: {
          id: 'evt_planactor001',
          type: 'session.plan.todo_upserted',
          payload: { sessionId: 'ses_planproject1', todo },
          at: createdAt
        }
      },
      rejectedReplayAfterLeave: { ok: false, replayed: false, code: 'actor_not_bound' },
      rejectedAssignee: { ok: false, replayed: false, code: 'assignee_not_found' },
      rejectedMissingIdentity: { ok: false, replayed: false, code: 'actor_not_bound' },
      rejectedActor: { ok: false, replayed: false, code: 'actor_not_bound' },
      rejectedUnknownActor: { ok: false, replayed: false, code: 'actor_not_bound' },
      projectTodos: [
        {
          id: 'todo_planactor001',
          assigneeProjectMemberId: 'pmem_plan_author',
          createdBy: memberActor
        }
      ],
      plainPlan: null
    });
  } finally {
    rootStore.close();
  }
});
