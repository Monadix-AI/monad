import type { ProjectController } from '../use-project';

import { useEffect, useState } from 'react';

import { MeshAgentMemberDialog } from './MeshAgentMemberDialog';
import { type MeshAgentMemberDialogState, meshAgentMemberDialogStateForMember } from './mesh-agent-member-dialog-model';
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
  const [meshAgentInvite, setMeshAgentInvite] = useState<MeshAgentMemberDialogState | null>(null);

  useEffect(() => {
    if (!member) {
      setMeshAgentInvite(null);
      return;
    }
    setMeshAgentInvite(meshAgentMemberDialogStateForMember(room, member));
  }, [member, room]);

  if (!member) return null;
  if (member.type === 'mesh-agent') {
    return (
      <MeshAgentMemberDialog
        invite={meshAgentInvite}
        onChange={setMeshAgentInvite}
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
