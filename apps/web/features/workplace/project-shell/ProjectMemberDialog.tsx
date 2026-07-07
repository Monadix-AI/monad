import type { ProjectController } from '../use-project';

import { useEffect, useState } from 'react';

import { ExternalAgentMemberDialog } from './ExternalAgentMemberDialog';
import {
  type ExternalAgentMemberDialogState,
  externalAgentMemberDialogStateForMember
} from './external-agent-member-dialog-model';
import { ProjectMemberSettingsDialog } from './ProjectMemberSettingsDialog';

type ProjectMember = ProjectController['projectMembers'][number];

export function ProjectMemberDialog({
  memberId,
  onClose,
  room
}: {
  memberId: string | null;
  onClose: () => void;
  room: ProjectController;
}): React.ReactElement | null {
  const member = memberId ? room.projectMembers.find((candidate) => candidate.id === memberId) : undefined;
  const [externalAgentInvite, setExternalAgentInvite] = useState<ExternalAgentMemberDialogState | null>(null);

  useEffect(() => {
    if (!member) {
      setExternalAgentInvite(null);
      return;
    }
    setExternalAgentInvite(externalAgentMemberDialogStateForMember(room, member));
  }, [member, room]);

  if (!member) return null;
  if (member.type === 'external-agent') {
    return (
      <ExternalAgentMemberDialog
        invite={externalAgentInvite}
        onChange={setExternalAgentInvite}
        onClose={onClose}
        room={room}
      />
    );
  }

  return (
    <ProjectMemberSettingsDialog
      member={member as ProjectMember}
      onClose={onClose}
      room={room}
    />
  );
}
