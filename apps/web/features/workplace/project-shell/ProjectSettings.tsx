import { ChevronRightIcon, Delete02Icon, MinusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ProductIcon } from '@monad/ui';
import { useCallback, useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { defaultReasoningEffort } from '@/components/ReasoningEffortControl';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { AgentIdentity, AgentInstanceAvatar, PresenceBadge, resolveProductIcon } from '../Bits';
import { boxR, mono, sans, sectionLabel } from '../styles';
import { type ProjectController, projectMemberParticipants } from '../use-project';
import {
  NativeCliMemberDialog,
  type NativeCliMemberDialogState,
  nativeCliMemberDialogStateForMember
} from './NativeCliMemberDialog';
import { ProjectAddMemberSection } from './ProjectAddMemberSection';
import { ProjectMemberSettingsDialog } from './ProjectMemberSettingsDialog';

type Translate = ReturnType<typeof useT>;
type ProjectMember = ProjectController['projectMembers'][number];

function removeLabel(id: string, t: Translate): string {
  if (id === 'monad') return t('web.workplace.removeAcpMember');
  if (id.startsWith('native-cli:')) return t('web.workplace.removeCliMember');
  if (id.startsWith('acp:')) return t('web.workplace.removeAcpMember');
  return t('web.workplace.managedByMonad');
}

export function ProjectSettings({
  room,
  onClose,
  onDeleted,
  initialIntent,
  initialMemberId = null
}: {
  room: ProjectController;
  onClose: () => void;
  onDeleted?: () => void;
  initialIntent?: 'connect-agent' | 'spawn-agent';
  initialMemberId?: string | null;
}): React.ReactElement {
  const t = useT();
  const [memberSettings, setMemberSettings] = useState<ProjectMember | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [nativeCliInvite, setNativeCliInvite] = useState<NativeCliMemberDialogState | null>(null);
  const projectParticipants = projectMemberParticipants(room.participants);
  const regularCandidates = room.availableProjectMembers.filter((candidate) => candidate.type !== 'native-cli');
  const nativeCliCandidates = room.availableProjectMembers.filter((candidate) => candidate.type === 'native-cli');

  const openNativeCliMemberSettings = useCallback(
    (member: ProjectMember) => {
      const invite = nativeCliMemberDialogStateForMember(room, member);
      if (!invite) return false;
      setNativeCliInvite(invite);
      return true;
    },
    [room]
  );

  useEffect(() => {
    if (!initialMemberId) return;
    const member = room.projectMembers.find((candidate) => candidate.id === initialMemberId);
    if (!member) return;
    if (openNativeCliMemberSettings(member)) return;
    setMemberSettings(member);
  }, [initialMemberId, openNativeCliMemberSettings, room.projectMembers]);

  const deleteProject = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await room.deleteProject();
      onDeleted?.();
      onClose();
    } catch {
      setDeleting(false);
    }
  };

  return (
    <>
      <Dialog
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        open
      >
        <DialogContent
          className="flex h-[min(780px,calc(100vh-1.5rem))] min-w-0 max-w-3xl flex-col overflow-hidden p-0 sm:max-w-3xl"
          showCloseButton
        >
          <div style={{ borderBottom: `1px solid ${'var(--border)'}`, padding: '16px 18px 14px' }}>
            <div style={{ ...sectionLabel, marginBottom: 6 }}>{t('web.workplace.projectSettingsLabel')}</div>
            <DialogTitle style={{ fontFamily: sans, fontSize: 18, fontWeight: 650, lineHeight: 1.25 }}>
              {t('web.workplace.membersTitle')}
            </DialogTitle>
            <p
              style={{ marginTop: 5, maxWidth: 560, fontFamily: sans, fontSize: 13, color: 'var(--muted-foreground)' }}
            >
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
                          if (openNativeCliMemberSettings(member)) return;
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
              {projectParticipants.length === 0 ? (
                <p style={{ margin: 0, fontFamily: sans, fontSize: 13, color: 'var(--muted-foreground)' }}>
                  {t('web.workplace.noMembersHint')}
                </p>
              ) : null}
            </section>

            <section style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={sectionLabel}>{t('web.workplace.addMembers')}</div>
              <ProjectAddMemberSection
                candidates={regularCandidates}
                onAdd={(candidate) => void room.addProjectMember(candidate.type, candidate.name)}
                promoted={initialIntent === 'connect-agent'}
                title={t('web.workplace.agentMembers')}
              />
              <ProjectAddMemberSection
                candidates={nativeCliCandidates}
                onAdd={(candidate) =>
                  setNativeCliInvite({
                    candidate,
                    draft: { reasoningEffort: defaultReasoningEffort(candidate.reasoningEfforts) }
                  })
                }
                promoted={initialIntent === 'spawn-agent'}
                title={t('web.workplace.nativeCliAgentMembers')}
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
        </DialogContent>
      </Dialog>
      <ProjectMemberSettingsDialog
        member={memberSettings}
        onClose={() => setMemberSettings(null)}
        room={room}
      />
      <NativeCliMemberDialog
        invite={nativeCliInvite}
        onChange={setNativeCliInvite}
        onClose={() => setNativeCliInvite(null)}
        room={room}
      />
    </>
  );
}
