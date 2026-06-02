import type { AvatarStyle, MeshAgentView } from '@monad/protocol';
import type { ProjectMemberOperations } from '@monad/sdk-atom';
import type { createSessionModule } from '#/handlers/session/index.ts';
import type { Store } from '#/store/db/index.ts';

import { entityAvatarUrl, meshAgentProjectMemberAvatarSeed } from '@monad/protocol';

export function createProjectMemberOperations(input: {
  avatarStyle: () => AvatarStyle;
  meshAgents: () => readonly MeshAgentView[];
  store: Store;
  sessions: ReturnType<typeof createSessionModule>;
}): ProjectMemberOperations {
  const { store, sessions } = input;
  return {
    listTemplates: async (projectId) => {
      const project = store.getWorkplaceProject(projectId);
      if (!project) throw new Error(`project not found: ${projectId}`);
      const meshAgents = input.meshAgents();
      const avatarStyle = input.avatarStyle();
      return project.memberTemplates.map((template) => {
        if (template.type === 'acp') {
          return {
            ...template,
            presentation: { avatarUrl: entityAvatarUrl(`acp:${template.name}`, avatarStyle) }
          };
        }
        const agent = meshAgents.find((candidate) => candidate.name === template.name);
        const label = template.displayName ?? agent?.displayName ?? template.name;
        return {
          ...template,
          ...(agent?.displayName && !template.displayName ? { displayName: agent.displayName } : {}),
          presentation: {
            avatarUrl: entityAvatarUrl(meshAgentProjectMemberAvatarSeed(projectId, label), avatarStyle),
            ...(agent?.productIcon ? { icon: agent.productIcon } : {}),
            ...(agent?.provider ? { provider: agent.provider } : {})
          }
        };
      });
    },
    listSessionMembers: async (sessionId) => {
      const result = await sessions.listSessionMembers({ sessionId: sessionId as `ses_${string}` });
      return result.members;
    },
    inviteSessionMember: async (sessionId, templateId) => {
      return sessions.inviteSessionMember({
        sessionId: sessionId as `ses_${string}`,
        templateId
      });
    },
    removeSessionMember: async (sessionId, memberId) => {
      await sessions.removeSessionMember({
        sessionId: sessionId as `ses_${string}`,
        memberId
      });
    }
  };
}
