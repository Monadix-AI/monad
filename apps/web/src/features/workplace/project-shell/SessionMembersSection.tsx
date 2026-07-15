import type { SessionId } from '@monad/protocol';
import type { ProjectController } from '../use-project';
import type { ExternalAgentMemberDialogState } from './external-agent-member-dialog-model';

import { MinusSignIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useInviteSessionMemberMutation,
  useListSessionMembersQuery,
  useRemoveSessionMemberMutation,
  useSpawnSessionMemberMutation
} from '@monad/client-rtk';
import {
  AgentIdentity,
  AgentInstanceAvatar,
  workspaceBoxRadius as boxR,
  workspaceMono as mono,
  workspaceSans as sans,
  workspaceSectionLabelStyle as sectionLabel
} from '@monad/ui/components/AgentAvatar';
import { useState } from 'react';

import { DestructiveConfirmPopover } from '#/components/DestructiveConfirmPopover';
import { useT } from '#/components/I18nProvider';
import { ExternalAgentMemberDialog } from './ExternalAgentMemberDialog';

type ProjectMember = ProjectController['projectMembers'][number];
type AvailableProjectMember = ProjectController['availableProjectMembers'][number];

function MemberRow({
  index,
  name,
  onRemove
}: {
  index: number;
  name: string;
  onRemove: () => Promise<unknown>;
}): React.ReactElement {
  const t = useT();
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
        agent={{ name }}
        bare
        size={30}
      />
      <div style={{ minWidth: 0 }}>
        <AgentIdentity
          name={name}
          nameStyle={{ fontFamily: sans, fontSize: 14, fontWeight: 600 }}
        />
      </div>
      <DestructiveConfirmPopover
        confirmLabel={t('web.workplace.removeSessionMemberConfirmAction')}
        description={t('web.workplace.removeSessionMemberConfirmDescription', { name })}
        onConfirm={onRemove}
      >
        <button
          aria-label={t('web.workplace.removeSessionMemberAriaLabel', { name })}
          className="workplace-action"
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
      </DestructiveConfirmPopover>
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
  const { data } = useListSessionMembersQuery(activeSessionId ?? ('ses_' as SessionId), {
    skip: activeSessionId === null
  });
  const members = data?.ids.map((id) => data.entities[id]).filter((member) => member !== undefined) ?? [];
  const [inviteSessionMember, inviteState] = useInviteSessionMemberMutation();
  const [spawnSessionMember, spawnState] = useSpawnSessionMemberMutation();
  const [removeSessionMember] = useRemoveSessionMemberMutation();
  const [externalAgentInvite, setExternalAgentInvite] = useState<ExternalAgentMemberDialogState | null>(null);

  const invitedTemplateIds = new Set(members.map((member) => member.templateId).filter((id) => id !== undefined));
  const availableTemplates = templates.filter((template) => !invitedTemplateIds.has(template.id));
  const externalAgentCandidates = availableProjectMembers.filter((candidate) => candidate.type === 'external-agent');

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
            {members.length === 0 ? (
              <p style={{ margin: 0, padding: 12, fontFamily: sans, fontSize: 13, color: 'var(--muted-foreground)' }}>
                {t('web.workplace.noSessionMembersHint')}
              </p>
            ) : null}
            {members.map((member, index) => (
              <MemberRow
                index={index}
                key={member.id}
                name={member.displayName ?? member.name}
                onRemove={() => removeSessionMember({ sessionId: activeSessionId, memberId: member.id }).unwrap()}
              />
            ))}
          </div>

          {availableTemplates.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ ...sectionLabel, color: 'var(--muted-foreground)' }}>
                {t('web.workplace.projectTemplates')}
              </div>
              <div style={{ border: `1px solid ${'var(--border)'}`, borderRadius: boxR, background: 'var(--card)' }}>
                {availableTemplates.map((template, index) => (
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
                      agent={{ ...template, name: template.displayName ?? template.name }}
                      bare
                      size={30}
                    />
                    <div style={{ minWidth: 0 }}>
                      <AgentIdentity
                        name={template.displayName ?? template.name}
                        nameStyle={{ fontFamily: sans, fontSize: 14, fontWeight: 600 }}
                      />
                    </div>
                    <button
                      aria-label={t('web.workplace.inviteIntoSessionAriaLabel', {
                        name: template.displayName ?? template.name
                      })}
                      className="workplace-action"
                      disabled={inviteState.isLoading}
                      onClick={() => void inviteSessionMember({ sessionId: activeSessionId, templateId: template.id })}
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
                ))}
              </div>
            </div>
          ) : null}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ ...sectionLabel, color: 'var(--muted-foreground)' }}>
              {t('web.workplace.directSessionMembers')}
            </div>
            <div style={{ border: `1px solid ${'var(--border)'}`, borderRadius: boxR, background: 'var(--card)' }}>
              {externalAgentCandidates.length === 0 ? (
                <p style={{ margin: 0, padding: 12, fontFamily: sans, fontSize: 13, color: 'var(--muted-foreground)' }}>
                  {t('web.workplace.noAvailableMembers')}
                </p>
              ) : null}
              {externalAgentCandidates.map((candidate, index) => (
                <div
                  key={candidate.id}
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
                    agent={{ ...candidate, name: candidate.label }}
                    bare
                    size={30}
                  />
                  <div style={{ minWidth: 0 }}>
                    <AgentIdentity
                      name={candidate.label}
                      nameStyle={{ fontFamily: sans, fontSize: 14, fontWeight: 600 }}
                    />
                  </div>
                  <button
                    className="workplace-action"
                    disabled={!candidate.enabled || spawnState.isLoading}
                    onClick={() =>
                      setExternalAgentInvite({
                        candidate,
                        draft: {
                          displayName: candidate.template?.displayName,
                          projectTemplateId: candidate.template?.id,
                          modelId: candidate.template?.modelId,
                          reasoningEffort: candidate.reasoningEfforts.includes(
                            candidate.template?.reasoningEffort ?? ''
                          )
                            ? candidate.template?.reasoningEffort
                            : undefined,
                          speed: candidate.template?.speed,
                          customPrompt: candidate.template?.customPrompt
                        }
                      })
                    }
                    style={{
                      minHeight: 28,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      border: `1px solid ${candidate.enabled ? 'var(--accent-blue)' : 'var(--border)'}`,
                      borderRadius: 8,
                      background: candidate.enabled ? 'var(--accent-blue-soft)' : 'var(--secondary)',
                      color: candidate.enabled ? 'var(--accent-blue)' : 'var(--muted-foreground)',
                      fontFamily: mono,
                      fontSize: 11,
                      padding: '5px 9px',
                      whiteSpace: 'nowrap'
                    }}
                    title={
                      candidate.enabled
                        ? t('web.workplace.configureAndInviteSessionMember')
                        : t('web.workplace.enableAgentFirst')
                    }
                    type="button"
                  >
                    <HugeiconsIcon
                      icon={PlusSignIcon}
                      size={14}
                    />
                    {t('web.workplace.configure')}
                  </button>
                </div>
              ))}
            </div>
          </div>
          <ExternalAgentMemberDialog
            invite={externalAgentInvite}
            onChange={setExternalAgentInvite}
            onClose={() => setExternalAgentInvite(null)}
            onSave={(invite) =>
              spawnSessionMember({
                sessionId: activeSessionId,
                type: 'external-agent',
                name: invite.candidate.name,
                displayName: invite.draft.displayName,
                settings: {
                  ...(invite.draft.modelId ? { modelId: invite.draft.modelId } : {}),
                  ...(invite.draft.reasoningEffort ? { reasoningEffort: invite.draft.reasoningEffort } : {}),
                  ...(invite.draft.speed ? { speed: invite.draft.speed } : {}),
                  ...(invite.draft.appServerTransport ? { appServerTransport: invite.draft.appServerTransport } : {}),
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
