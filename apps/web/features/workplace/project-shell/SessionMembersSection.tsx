import type { SessionId } from '@monad/protocol';
import type { ProjectController } from '../use-project';

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

import { useT } from '#/components/I18nProvider';

type ProjectMember = ProjectController['projectMembers'][number];

function MemberRow({
  index,
  name,
  onRemove,
  removeTitle
}: {
  index: number;
  name: string;
  onRemove: () => void;
  removeTitle: string;
}): React.ReactElement {
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
      <button
        className="workplace-action"
        onClick={onRemove}
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
        title={removeTitle}
        type="button"
      >
        <HugeiconsIcon
          icon={MinusSignIcon}
          size={14}
        />
      </button>
    </div>
  );
}

/** Per-session member bindings (Track B, decision 4) — distinct from the project's memberTemplates
 *  catalog shown in the Templates tab. Invites a template into just this session (each session's
 *  binding starts its own runtime, never shared), or spawns an ad-hoc member with no template link. */
export function SessionMembersSection({
  activeSessionId,
  templates
}: {
  activeSessionId: SessionId | null;
  templates: ProjectMember[];
}): React.ReactElement {
  const t = useT();
  const { data } = useListSessionMembersQuery(activeSessionId ?? ('ses_' as SessionId), {
    skip: activeSessionId === null
  });
  const members = data?.ids.map((id) => data.entities[id]).filter((member) => member !== undefined) ?? [];
  const [inviteSessionMember] = useInviteSessionMemberMutation();
  const [spawnSessionMember] = useSpawnSessionMemberMutation();
  const [removeSessionMember] = useRemoveSessionMemberMutation();
  const [adHocName, setAdHocName] = useState('');

  const invitedTemplateIds = new Set(members.map((member) => member.templateId).filter((id) => id !== undefined));
  const availableTemplates = templates.filter((template) => !invitedTemplateIds.has(template.id));

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={sectionLabel}>{t('web.workplace.sessionMembersTitle')}</div>
      <p style={{ margin: 0, fontFamily: sans, fontSize: 12, color: 'var(--muted-foreground)' }}>
        {t('web.workplace.sessionMembersDescription')}
      </p>
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
                onRemove={() => void removeSessionMember({ sessionId: activeSessionId, memberId: member.id })}
                removeTitle={t('web.workplace.removeSessionMember')}
              />
            ))}
          </div>

          {availableTemplates.length > 0 ? (
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
                    className="workplace-action"
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
          ) : null}

          <div style={{ display: 'flex', gap: 8 }}>
            <input
              onChange={(event) => setAdHocName(event.target.value)}
              placeholder={t('web.workplace.spawnAdHocPlaceholder')}
              style={{
                flex: 1,
                minWidth: 0,
                border: `1px solid ${'var(--border)'}`,
                borderRadius: 8,
                background: 'var(--card)',
                color: 'var(--foreground)',
                fontFamily: mono,
                fontSize: 12,
                padding: '6px 9px'
              }}
              value={adHocName}
            />
            <button
              className="workplace-action"
              disabled={!adHocName.trim()}
              onClick={() => {
                const name = adHocName.trim();
                if (!name) return;
                void spawnSessionMember({ sessionId: activeSessionId, type: 'external-agent', name });
                setAdHocName('');
              }}
              style={{
                minHeight: 30,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                border: `1px solid ${'var(--border)'}`,
                borderRadius: 8,
                background: 'var(--secondary)',
                color: 'var(--foreground)',
                fontFamily: mono,
                fontSize: 11,
                padding: '5px 10px',
                whiteSpace: 'nowrap'
              }}
              type="button"
            >
              {t('web.workplace.spawnAdHoc')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
