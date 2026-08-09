import type { SessionId } from '@monad/protocol';
import type { ProjectController } from '../use-project';
import type { MeshAgentDraft, MeshAgentMemberDialogState } from './mesh-agent-member-dialog-model';

import { MinusSignIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useInviteSessionMemberMutation,
  useListSessionMembersQuery,
  useRemoveSessionMemberMutation,
  useSpawnSessionMemberMutation
} from '@monad/client-rtk';
import { entityAvatarUrl, meshAgentProjectMemberAvatarSeed } from '@monad/protocol';
import { Confirm } from '@monad/ui';
import {
  AgentIdentity,
  AgentInstanceAvatar,
  workspaceBoxRadius as boxR,
  workspaceMono as mono,
  workspaceSans as sans,
  workspaceSectionLabelStyle as sectionLabel
} from '@monad/ui/components/AgentAvatar';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { isResolvedEmptyList } from '#/lib/async-list-state';
import { MeshAgentMemberDialog } from './MeshAgentMemberDialog';
import { ProjectAddMemberSection } from './ProjectAddMemberSection';
import { ProjectMembersListSkeleton } from './ProjectSettingsListSkeletons';

type ProjectMember = ProjectController['projectMembers'][number];
type AvailableProjectMember = ProjectController['availableProjectMembers'][number];
type ProjectParticipant = ProjectController['projectParticipants'][number];

type MemberAvatar = {
  av?: ProjectParticipant['av'];
  avatarUrl?: ProjectParticipant['avatarUrl'];
  icon?: ProjectParticipant['icon'];
  name: string;
};

export function directSessionMemberCandidates(candidates: readonly AvailableProjectMember[]): AvailableProjectMember[] {
  return candidates.filter((candidate) => candidate.type === 'mesh-agent');
}

export function directSessionMemberDraft(candidate: AvailableProjectMember): MeshAgentDraft {
  return { displayName: candidate.label };
}

export function sessionMemberAvatar(args: {
  avatarStyle: ProjectController['source']['avatarStyle'];
  candidate?: AvailableProjectMember;
  displayName: string;
  participant?: ProjectParticipant;
  projectId: string;
}): MemberAvatar {
  return {
    ...args.participant,
    avatarUrl: entityAvatarUrl(meshAgentProjectMemberAvatarSeed(args.projectId, args.displayName), args.avatarStyle),
    icon: args.participant?.icon ?? args.candidate?.icon,
    name: args.displayName
  };
}

export function sessionProjectMemberDisplayName(args: {
  candidate?: AvailableProjectMember;
  fallbackName: string;
  template?: ProjectMember;
}): string {
  return args.template?.displayName ?? args.candidate?.label ?? args.fallbackName;
}

export function shouldDeferSessionMemberRoster(args: {
  activeSessionId: SessionId | null;
  hasCurrentData: boolean;
  isFetching: boolean;
  isLoading: boolean;
}): boolean {
  return args.activeSessionId !== null && !args.hasCurrentData && (args.isLoading || args.isFetching);
}

function MemberRow({
  avatar,
  index,
  onRemove
}: {
  avatar: MemberAvatar;
  index: number;
  onRemove: () => Promise<unknown>;
}): React.ReactElement {
  const t = useT();
  const name = avatar.name;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '32px minmax(0, 1fr) auto',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        borderTop: index === 0 ? 'none' : `1px solid ${'var(--border)'}`
      }}
    >
      <AgentInstanceAvatar
        agent={avatar}
        bare
        size={30}
      />
      <div style={{ minWidth: 0 }}>
        <AgentIdentity
          icon={avatar.icon}
          name={name}
          nameStyle={{ fontFamily: sans, fontSize: 14, fontWeight: 600 }}
        />
      </div>
      <button
        aria-label={t('web.workplace.removeSessionMemberAriaLabel', { name })}
        className="workplace-action"
        onClick={() => {
          setRemoveFailed(false);
          setConfirmRemove(true);
        }}
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
        title={t('web.workplace.removeSessionMemberAriaLabel', { name })}
        type="button"
      >
        <HugeiconsIcon
          icon={MinusSignIcon}
          size={14}
        />
      </button>
      <Confirm
        cancelLabel={t('web.common.cancel')}
        confirmLabel={t('web.workplace.removeSessionMemberConfirmAction')}
        confirmVariant="destructive"
        description={t('web.workplace.removeSessionMemberConfirmDescription', { name })}
        error={removeFailed ? t('web.workplace.removeSessionMemberFailed') : undefined}
        onConfirm={() => {
          setRemoving(true);
          setRemoveFailed(false);
          void onRemove()
            .then(() => setConfirmRemove(false))
            .catch(() => setRemoveFailed(true))
            .finally(() => setRemoving(false));
        }}
        onOpenChange={setConfirmRemove}
        open={confirmRemove}
        pending={removing}
        pendingLabel={t('web.workplace.removingSessionMember')}
        title={t('web.workplace.removeSessionMember')}
      />
    </div>
  );
}

/** Per-session member bindings (Track B, decision 4) — distinct from the project's memberTemplates
 *  catalog shown in the Templates tab. Invites a template into just this session (each session's
 *  binding starts its own runtime, never shared), or spawns an ad-hoc member with no template link. */
export function SessionMembersSection({
  activeSessionId,
  availableProjectMembers,
  room,
  templates
}: {
  activeSessionId: SessionId | null;
  availableProjectMembers: AvailableProjectMember[];
  room: ProjectController;
  templates: ProjectMember[];
}): React.ReactElement {
  const t = useT();
  const { currentData, isFetching, isLoading } = useListSessionMembersQuery(activeSessionId ?? ('ses_' as SessionId), {
    skip: activeSessionId === null
  });
  const members = currentData?.ids.map((id) => currentData.entities[id]).filter((member) => member !== undefined) ?? [];
  const rosterPending = shouldDeferSessionMemberRoster({
    activeSessionId,
    hasCurrentData: currentData !== undefined,
    isFetching,
    isLoading
  });
  const [inviteSessionMember, inviteState] = useInviteSessionMemberMutation();
  const [spawnSessionMember] = useSpawnSessionMemberMutation();
  const [removeSessionMember] = useRemoveSessionMemberMutation();
  const [meshAgentInvite, setMeshAgentInvite] = useState<MeshAgentMemberDialogState | null>(null);

  const invitedTemplateIds = new Set(members.map((member) => member.member.profileId));
  const availableTemplates = templates.filter((template) => !invitedTemplateIds.has(template.id));
  const meshAgentCandidates = directSessionMemberCandidates(availableProjectMembers);
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const participantById = new Map(room.projectParticipants.map((participant) => [participant.id, participant]));
  const candidateByName = new Map(meshAgentCandidates.map((candidate) => [candidate.name, candidate]));

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={sectionLabel}>{t('web.workplace.sessionMembersTitle')}</div>
        <p style={{ margin: 0, fontFamily: sans, fontSize: 12, color: 'var(--muted-foreground)' }}>
          {t('web.workplace.sessionMembersDescription')}
        </p>
      </div>
      {!activeSessionId ? (
        <p style={{ margin: 0, fontFamily: sans, fontSize: 13, color: 'var(--muted-foreground)' }}>
          {t('web.workplace.noActiveSession')}
        </p>
      ) : (
        <>
          <div style={{ border: `1px solid ${'var(--border)'}`, borderRadius: boxR, background: 'var(--card)' }}>
            {rosterPending ? <ProjectMembersListSkeleton /> : null}
            {isResolvedEmptyList({ isLoading: rosterPending, itemCount: members.length }) ? (
              <p style={{ margin: 0, padding: 12, fontFamily: sans, fontSize: 13, color: 'var(--muted-foreground)' }}>
                {t('web.workplace.noSessionMembersHint')}
              </p>
            ) : null}
            {!rosterPending
              ? members.map((member, index) => {
                  const template = templateById.get(member.member.profileId);
                  const candidate = template ? candidateByName.get(template.templateName ?? template.name) : undefined;
                  const participant = participantById.get(member.member.id);
                  const displayName = sessionProjectMemberDisplayName({
                    candidate,
                    fallbackName: member.member.displayName,
                    template
                  });
                  const avatar = sessionMemberAvatar({
                    avatarStyle: room.source.avatarStyle,
                    candidate,
                    displayName,
                    participant,
                    projectId: room.activeProjectId ?? room.projectId
                  });
                  return (
                    <MemberRow
                      avatar={avatar}
                      index={index}
                      key={member.member.id}
                      onRemove={() =>
                        removeSessionMember({ sessionId: activeSessionId, memberId: member.member.id }).unwrap()
                      }
                    />
                  );
                })
              : null}
          </div>

          {!rosterPending && availableTemplates.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ ...sectionLabel, color: 'var(--muted-foreground)' }}>
                {t('web.workplace.projectMembersTitle')}
              </div>
              <div style={{ border: `1px solid ${'var(--border)'}`, borderRadius: boxR, background: 'var(--card)' }}>
                {availableTemplates.map((template, index) => {
                  const participant = participantById.get(template.id);
                  const candidate = candidateByName.get(template.templateName ?? template.name);
                  const name = sessionProjectMemberDisplayName({ candidate, fallbackName: template.name, template });
                  const avatar = sessionMemberAvatar({
                    avatarStyle: room.source.avatarStyle,
                    candidate,
                    displayName: name,
                    participant,
                    projectId: room.activeProjectId ?? room.projectId
                  });
                  return (
                    <div
                      key={template.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '32px minmax(0, 1fr) auto',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 12px',
                        borderTop: index === 0 ? 'none' : `1px solid ${'var(--border)'}`
                      }}
                    >
                      <AgentInstanceAvatar
                        agent={avatar}
                        bare
                        size={30}
                      />
                      <div style={{ minWidth: 0 }}>
                        <AgentIdentity
                          icon={avatar.icon}
                          name={name}
                          nameStyle={{ fontFamily: sans, fontSize: 14, fontWeight: 600 }}
                        />
                      </div>
                      <button
                        aria-label={t('web.workplace.inviteIntoSessionAriaLabel', { name })}
                        className="workplace-action"
                        disabled={inviteState.isLoading}
                        onClick={() =>
                          void inviteSessionMember({ sessionId: activeSessionId, templateId: template.id })
                        }
                        style={{
                          minHeight: 28,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 6,
                          border: `1px solid ${'var(--accent-blue)'}`,
                          borderRadius: 8,
                          background: 'var(--accent-blue-soft)',
                          color: 'var(--accent-blue)',
                          fontFamily: mono,
                          fontSize: 11,
                          padding: '5px 9px',
                          whiteSpace: 'nowrap'
                        }}
                        title={t('web.workplace.inviteIntoSession')}
                        type="button"
                      >
                        <HugeiconsIcon
                          icon={PlusSignIcon}
                          size={14}
                        />
                        {t('web.workplace.inviteIntoSession')}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ ...sectionLabel, color: 'var(--muted-foreground)' }}>
              {t('web.workplace.directSessionMembers')}
            </div>
            <ProjectAddMemberSection
              candidates={meshAgentCandidates}
              loading={room.membersLoading}
              onAdd={(candidate) => setMeshAgentInvite({ candidate, draft: directSessionMemberDraft(candidate) })}
            />
          </div>
          <MeshAgentMemberDialog
            invite={meshAgentInvite}
            onChange={setMeshAgentInvite}
            onClose={() => setMeshAgentInvite(null)}
            onSave={(invite) =>
              spawnSessionMember({
                sessionId: activeSessionId,
                type: 'mesh-agent',
                name: invite.candidate.name,
                displayName: invite.draft.displayName,
                settings: {
                  ...(invite.draft.modelId ? { modelId: invite.draft.modelId } : {}),
                  ...(invite.draft.reasoningEffort ? { reasoningEffort: invite.draft.reasoningEffort } : {}),
                  ...(invite.draft.speed ? { speed: invite.draft.speed } : {}),
                  ...(invite.draft.customPrompt ? { customPrompt: invite.draft.customPrompt } : {})
                }
              }).unwrap()
            }
            room={room}
          />
        </>
      )}
    </section>
  );
}
