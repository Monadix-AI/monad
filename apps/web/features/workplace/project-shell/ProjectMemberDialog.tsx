import type { ProjectController } from '../use-project';

import { useEffect, useState } from 'react';

import {
  NativeCliMemberDialog,
  type NativeCliMemberDialogState,
  nativeCliMemberDialogStateForMember
} from './NativeCliMemberDialog';
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
  const [nativeCliInvite, setNativeCliInvite] = useState<NativeCliMemberDialogState | null>(null);

  useEffect(() => {
    if (!member) {
      setNativeCliInvite(null);
      return;
    }
    setNativeCliInvite(nativeCliMemberDialogStateForMember(room, member));
  }, [member, room]);

  if (!member) return null;
  if (member.type === 'native-cli') {
    return (
      <NativeCliMemberDialog
        invite={nativeCliInvite}
        onChange={setNativeCliInvite}
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
