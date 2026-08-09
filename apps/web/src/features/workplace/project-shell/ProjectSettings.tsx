import type { ProjectExperienceDefinition } from '../experiences/types';
import type { ProjectController } from '../use-project';

import { Delete02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  workspaceBoxRadius as boxR,
  workspaceMono as mono,
  workspaceSans as sans
} from '@monad/ui/components/AgentAvatar';
import { useCallback, useEffect, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { RefreshButton } from '#/components/RefreshButton';
import { PanelShellHeader } from '#/components/ui/panel-shell';
import { DeleteProjectDialog } from '../DeleteProjectDialog';
import { MeshAgentMemberDialog } from './MeshAgentMemberDialog';
import { type MeshAgentMemberDialogState, meshAgentMemberDialogStateForMember } from './mesh-agent-member-dialog-model';
import { type AvailableProjectMember, ProjectAddMemberSection } from './ProjectAddMemberSection';
import { ProjectExperienceSettings } from './ProjectExperienceSettings';
import { ProjectMemberSettingsDialog } from './ProjectMemberSettingsDialog';
import { ProjectMembersSection } from './ProjectMembersSection';
import './project-settings.css';
import { ProjectWorkdirSettings } from './ProjectWorkdirSettings';

type ProjectMember = ProjectController['projectMembers'][number];

export function ProjectSettings({
  room,
  onDeleted,
  initialIntent,
  initialMemberId = null,
  experiences = [],
  experiencesLoading = false,
  mode = '',
  onModeChange
}: {
  room: ProjectController;
  onDeleted?: () => void;
  initialIntent?: 'connect-agent' | 'spawn-agent';
  initialMemberId?: string | null;
  experiences?: ProjectExperienceDefinition[];
  experiencesLoading?: boolean;
  mode?: string;
  onModeChange?: (mode: string) => void;
}): React.ReactElement {
  const t = useT();
  const [memberSettings, setMemberSettings] = useState<ProjectMember | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [meshAgentInvite, setMeshAgentInvite] = useState<MeshAgentMemberDialogState | null>(null);

  const openMeshAgentMemberSettings = useCallback(
    (member: ProjectMember) => {
      const invite = meshAgentMemberDialogStateForMember(room, member);
      if (!invite) return false;
      setMeshAgentInvite(invite);
      return true;
    },
    [room]
  );

  useEffect(() => {
    if (!initialMemberId) return;
    const member = room.projectMembers.find((candidate) => candidate.id === initialMemberId);
    if (!member) return;
    if (openMeshAgentMemberSettings(member)) return;
    setMemberSettings(member);
  }, [initialMemberId, openMeshAgentMemberSettings, room.projectMembers]);

  const addAvailableMember = (candidate: AvailableProjectMember) => {
    if (candidate.type !== 'mesh-agent') {
      void room.addProjectMember(candidate.type, candidate.name);
      return;
    }
    setMeshAgentInvite({
      candidate,
      draft: {}
    });
  };

  return (
    <>
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
        <PanelShellHeader title={t('web.workplace.projectSettingsLabel')} />

        <div className="project-settings-layout scwf-scroll grid min-h-0 flex-1 overflow-y-auto p-5 max-sm:p-4">
          {initialIntent ? (
            <div
              className="project-settings-layout__notice"
              style={{
                marginBottom: 16,
                border: `1px solid ${'color-mix(in srgb, var(--accent-blue) 42%, var(--border))'}`,
                borderRadius: 12,
                background: 'color-mix(in srgb, var(--accent-blue) 9%, var(--card))',
                padding: '10px 12px'
              }}
            >
              <div style={{ fontFamily: sans, fontSize: 13, fontWeight: 650, color: 'var(--foreground)' }}>
                {initialIntent === 'spawn-agent'
                  ? t('web.workplace.emptySpawnHintTitle')
                  : t('web.workplace.emptyConnectHintTitle')}
              </div>
              <p style={{ margin: '3px 0 0', fontFamily: sans, fontSize: 12, color: 'var(--muted-foreground)' }}>
                {initialIntent === 'spawn-agent'
                  ? t('web.workplace.emptySpawnHint')
                  : t('web.workplace.emptyConnectHint')}
              </p>
            </div>
          ) : null}
          <ProjectExperienceSettings
            experiences={experiences}
            loading={experiencesLoading}
            mode={mode}
            onChange={onModeChange}
          />
          <ProjectWorkdirSettings
            labels={{
              description: t('web.workplace.workdirSettingsDescription'),
              empty: t('web.workplace.workdirSettingsUnset'),
              title: t('web.workplace.workdirSettingsTitle')
            }}
            path={room.workdir.path}
          />
          <ProjectMembersSection
            avatarStyle={room.source.avatarStyle}
            candidates={room.availableProjectMembers}
            loading={room.membersLoading}
            members={room.projectMembers}
            onOpenSettings={(member) => {
              if (openMeshAgentMemberSettings(member)) return;
              setMemberSettings(member);
            }}
            onRefresh={room.refreshMeshAgentCatalog}
            onRemove={room.removeProjectMember}
            projectId={room.projectId}
            refreshing={room.membersRefreshing}
          />

          <section
            aria-labelledby="agent-providers-heading"
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
              <div>
                <h3
                  id="agent-providers-heading"
                  style={{ margin: 0, fontFamily: sans, fontSize: 15, fontWeight: 650, color: 'var(--foreground)' }}
                >
                  {t('web.workplace.agentProvidersTitle')}
                </h3>
                <p
                  style={{
                    margin: '3px 0 0',
                    maxWidth: 600,
                    fontFamily: sans,
                    fontSize: 12,
                    lineHeight: 1.45,
                    color: 'var(--muted-foreground)'
                  }}
                >
                  {t('web.workplace.agentProvidersDescription')}
                </p>
              </div>
              <RefreshButton
                className="size-7"
                iconOnly
                label={t('web.refresh')}
                loading={room.membersRefreshing}
                onClick={room.refreshMeshAgentCatalog}
                size="icon"
                variant="ghost"
              />
            </div>
            <ProjectAddMemberSection
              candidates={room.availableProjectMembers}
              loading={room.membersLoading}
              onAdd={addAvailableMember}
              promoted={Boolean(initialIntent)}
            />
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontFamily: sans, fontSize: 12, fontWeight: 600, color: 'var(--destructive)' }}>
              {t('web.workplace.dangerZone')}
            </div>
            <div
              style={{
                border: `1px solid ${'color-mix(in srgb, var(--destructive) 38%, var(--border))'}`,
                borderRadius: boxR,
                background: 'color-mix(in srgb, var(--destructive) 7%, var(--card))',
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                alignItems: 'center',
                gap: 12,
                padding: 12
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: sans, fontSize: 14, fontWeight: 650, color: 'var(--foreground)' }}>
                  {t('web.workplace.deleteProject')}
                </div>
                <p style={{ margin: '4px 0 0', fontFamily: sans, fontSize: 12, color: 'var(--muted-foreground)' }}>
                  {t('web.workplace.deleteProjectHint')}
                </p>
              </div>
              <button
                className="workplace-action"
                disabled={!room.ready}
                onClick={() => setDeleteDialogOpen(true)}
                style={{
                  minHeight: 30,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  border: `1px solid ${'var(--destructive)'}`,
                  borderRadius: 8,
                  background: 'transparent',
                  color: 'var(--destructive)',
                  fontFamily: mono,
                  fontSize: 11,
                  padding: '5px 10px',
                  whiteSpace: 'nowrap'
                }}
                type="button"
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  size={14}
                />
                {t('web.workplace.deleteProject')}
              </button>
            </div>
          </section>
        </div>
      </section>
      <DeleteProjectDialog
        onConfirm={room.deleteProject}
        onDeleted={onDeleted}
        onOpenChange={setDeleteDialogOpen}
        open={deleteDialogOpen}
        projectName={room.source.project?.title ?? room.projectId}
      />
      <ProjectMemberSettingsDialog
        member={memberSettings}
        onClose={() => setMemberSettings(null)}
        room={room}
      />
      <MeshAgentMemberDialog
        invite={meshAgentInvite}
        onChange={setMeshAgentInvite}
        onClose={() => setMeshAgentInvite(null)}
        room={room}
      />
    </>
  );
}
