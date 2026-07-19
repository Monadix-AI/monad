import type { ProjectController } from '../use-project';

import { ChevronRightIcon, Delete02Icon, MinusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ProductIcon } from '@monad/ui';
import {
  AgentIdentity,
  AgentInstanceAvatar,
  workspaceBoxRadius as boxR,
  workspaceMono as mono,
  PresenceBadge,
  resolveProductIcon,
  workspaceSans as sans,
  workspaceSectionLabelStyle as sectionLabel
} from '@monad/ui/components/AgentAvatar';
import { useCallback, useEffect, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { isResolvedEmptyList } from '#/lib/async-list-state';
import { MeshAgentMemberDialog } from './MeshAgentMemberDialog';
import { type MeshAgentMemberDialogState, meshAgentMemberDialogStateForMember } from './mesh-agent-member-dialog-model';
import { ProjectAddMemberSection } from './ProjectAddMemberSection';
import { ProjectMemberSettingsDialog } from './ProjectMemberSettingsDialog';

type Translate = ReturnType<typeof useT>;
type ProjectMember = ProjectController['projectMembers'][number];

function removeLabel(id: string, t: Translate): string {
  if (id === 'monad') return t('web.workplace.removeAcpMember');
  if (id.startsWith('mesh-agent:')) return t('web.workplace.removeCliMember');
  if (id.startsWith('acp:')) return t('web.workplace.removeAcpMember');
  return t('web.workplace.managedByMonad');
}

export function ProjectSettings({
  room,
  onDeleted,
  initialIntent,
  initialMemberId = null
}: {
  room: ProjectController;
  onDeleted?: () => void;
  initialIntent?: 'connect-agent' | 'spawn-agent';
  initialMemberId?: string | null;
}): React.ReactElement {
  const t = useT();
  const [memberSettings, setMemberSettings] = useState<ProjectMember | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [meshAgentInvite, setMeshAgentInvite] = useState<MeshAgentMemberDialogState | null>(null);
  const projectParticipants = room.projectParticipants;
  const regularCandidates = room.availableProjectMembers.filter((candidate) => candidate.type !== 'mesh-agent');
  const meshAgentCandidates = room.availableProjectMembers.filter((candidate) => candidate.type === 'mesh-agent');

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

  const deleteProject = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await room.deleteProject();
      onDeleted?.();
    } catch {
      setDeleting(false);
    }
  };

  return (
    <>
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
        <div style={{ borderBottom: `1px solid ${'var(--border)'}`, padding: '16px 18px 14px' }}>
          <div style={{ ...sectionLabel, marginBottom: 6 }}>{t('web.workplace.projectSettingsLabel')}</div>
          <h2 style={{ margin: 0, fontFamily: sans, fontSize: 18, fontWeight: 650, lineHeight: 1.25 }}>
            {t('web.workplace.membersTitle')}
          </h2>
          <p style={{ marginTop: 5, maxWidth: 560, fontFamily: sans, fontSize: 13, color: 'var(--muted-foreground)' }}>
            {t('web.workplace.membersDescription')}
          </p>
        </div>

        <div className="scwf-scroll flex min-h-0 flex-1 flex-col overflow-y-auto p-[18px]">
          {initialIntent ? (
            <div
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
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={sectionLabel}>{t('web.workplace.currentMembers')}</div>
            <div style={{ border: `1px solid ${'var(--border)'}`, borderRadius: boxR, background: 'var(--card)' }}>
              {projectParticipants.map((participant, index) => {
                const member = room.projectMembers.find((candidate) => candidate.id === participant.id);
                const productIcon = participant.kind === 'agent' ? resolveProductIcon(participant) : undefined;
                return (
                  <div
                    key={participant.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '32px minmax(0, 1fr) auto auto',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 12px',
                      borderTop: index === 0 ? 'none' : `1px solid ${'var(--border)'}`
                    }}
                  >
                    <div style={{ position: 'relative', flex: 'none' }}>
                      <AgentInstanceAvatar
                        agent={participant}
                        size={30}
                      />
                      <PresenceBadge presence={participant.presence} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <AgentIdentity
                        badge={
                          productIcon ? (
                            <ProductIcon
                              product={productIcon}
                              size={12}
                            />
                          ) : null
                        }
                        badgeGap={4}
                        name={participant.name}
                        nameStyle={{ fontFamily: sans, fontSize: 14, fontWeight: 600 }}
                      />
                    </div>
                    <button
                      className="workplace-action"
                      disabled={!member}
                      onClick={() => {
                        if (!member) return;
                        if (openMeshAgentMemberSettings(member)) return;
                        setMemberSettings(member);
                      }}
                      style={{
                        width: 28,
                        height: 28,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: `1px solid ${'var(--border)'}`,
                        borderRadius: 8,
                        background: 'transparent',
                        color: member ? 'var(--foreground)' : 'var(--muted-foreground)'
                      }}
                      title={member ? t('web.workplace.memberSettings') : t('web.workplace.managedByMonad')}
                      type="button"
                    >
                      <HugeiconsIcon
                        icon={ChevronRightIcon}
                        size={14}
                      />
                    </button>
                    <button
                      className="workplace-action"
                      onClick={() => void room.removeProjectMember(participant.id)}
                      style={{
                        width: 28,
                        height: 28,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: `1px solid ${'var(--destructive)'}`,
                        borderRadius: 8,
                        background: 'transparent',
                        color: 'var(--destructive)'
                      }}
                      title={removeLabel(participant.id, t)}
                      type="button"
                    >
                      <HugeiconsIcon
                        icon={MinusSignIcon}
                        size={14}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
            {isResolvedEmptyList({ isLoading: room.membersLoading, itemCount: projectParticipants.length }) ? (
              <p style={{ margin: 0, fontFamily: sans, fontSize: 13, color: 'var(--muted-foreground)' }}>
                {t('web.workplace.noMembersHint')}
              </p>
            ) : null}
          </section>

          <section style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={sectionLabel}>{t('web.workplace.addMembers')}</div>
            <ProjectAddMemberSection
              candidates={regularCandidates}
              loading={room.membersLoading}
              onAdd={(candidate) => void room.addProjectMember(candidate.type, candidate.name)}
              promoted={initialIntent === 'connect-agent'}
              title={t('web.workplace.agentMembers')}
            />
            <ProjectAddMemberSection
              candidates={meshAgentCandidates}
              loading={room.membersLoading}
              onAdd={(candidate) =>
                setMeshAgentInvite({
                  candidate,
                  draft: {
                    displayName: candidate.template?.displayName,
                    projectTemplateId: candidate.template?.id,
                    modelId: candidate.template?.modelId,
                    reasoningEffort: candidate.reasoningEfforts.includes(candidate.template?.reasoningEffort ?? '')
                      ? candidate.template?.reasoningEffort
                      : undefined,
                    speed: candidate.template?.speed,
                    customPrompt: candidate.template?.customPrompt
                  }
                })
              }
              promoted={initialIntent === 'spawn-agent'}
              title={t('web.workplace.meshAgentMembers')}
            />
          </section>

          <section style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={sectionLabel}>{t('web.workplace.dangerZone')}</div>
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
                  {confirmDelete ? t('web.workplace.deleteProjectConfirmHint') : t('web.workplace.deleteProjectHint')}
                </p>
              </div>
              <button
                className="workplace-action"
                disabled={deleting || !room.ready}
                onClick={() => void deleteProject()}
                style={{
                  minHeight: 30,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  border: `1px solid ${'var(--destructive)'}`,
                  borderRadius: 8,
                  background: confirmDelete ? 'var(--destructive)' : 'transparent',
                  color: confirmDelete ? 'var(--destructive-foreground)' : 'var(--destructive)',
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
                {confirmDelete ? t('web.workplace.confirmDeleteProject') : t('web.workplace.deleteProject')}
              </button>
            </div>
          </section>
        </div>
      </section>
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
