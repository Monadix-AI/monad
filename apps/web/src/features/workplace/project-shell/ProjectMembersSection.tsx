import type { ProjectController } from '../use-project';

import { ChevronRightIcon, MinusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AgentIdentity,
  AgentInstanceAvatar,
  workspaceBoxRadius as boxR,
  workspaceMono as mono,
  PresenceBadge,
  resolveProductIcon,
  workspaceSans as sans
} from '@monad/ui/components/AgentAvatar';

import { useT } from '#/components/I18nProvider';
import { RefreshButton } from '#/components/RefreshButton';
import { SwitchSetting } from '#/components/ui/switch-setting';
import { isResolvedEmptyList } from '#/lib/async-list-state';
import { ProjectMembersListSkeleton } from './ProjectSettingsListSkeletons';

type ProjectMember = ProjectController['projectMembers'][number];
type ProjectParticipant = ProjectController['projectParticipants'][number];

export function projectMemberRemoveLabelKey(
  type: ProjectMember['type']
): 'web.workplace.removeAcpMember' | 'web.workplace.removeCliMember' {
  return type === 'acp' ? 'web.workplace.removeAcpMember' : 'web.workplace.removeCliMember';
}

export function ProjectMembersSection({
  autoInviteProjectMembers,
  loading,
  members,
  onOpenSettings,
  onRemove,
  onRefresh,
  onAutoInviteChange,
  participants,
  refreshing
}: {
  autoInviteProjectMembers: boolean;
  loading: boolean;
  members: ProjectController['projectMembers'];
  onOpenSettings: (member: ProjectMember) => void;
  onRemove: (memberId: string) => void;
  onRefresh: () => void;
  onAutoInviteChange: (checked: boolean) => void;
  participants: ProjectController['projectParticipants'];
  refreshing: boolean;
}): React.ReactElement {
  const t = useT();
  const empty = isResolvedEmptyList({ isLoading: loading, itemCount: participants.length });

  return (
    <section
      aria-labelledby="project-members-heading"
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h3
            id="project-members-heading"
            style={{ margin: 0, fontFamily: sans, fontSize: 15, fontWeight: 650, color: 'var(--foreground)' }}
          >
            {t('web.workplace.projectMembersTitle')}
          </h3>
          <p
            style={{
              margin: '3px 0 0',
              maxWidth: 560,
              fontFamily: sans,
              fontSize: 12,
              lineHeight: 1.45,
              color: 'var(--muted-foreground)'
            }}
          >
            {t('web.workplace.projectMembersDescription')}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <RefreshButton
            className="size-7"
            iconOnly
            label={t('web.refresh')}
            loading={refreshing}
            onClick={onRefresh}
            size="icon"
            variant="ghost"
          />
          <span
            style={{
              flex: 'none',
              borderRadius: 999,
              background: 'var(--secondary)',
              color: 'var(--muted-foreground)',
              fontFamily: mono,
              fontSize: 10,
              fontWeight: 600,
              padding: '4px 8px'
            }}
          >
            {participants.length}
          </span>
        </div>
      </div>
      <SwitchSetting
        checked={autoInviteProjectMembers}
        className="rounded-lg border bg-card p-3"
        description={t('web.workplace.autoInviteProjectMembersDescription')}
        onCheckedChange={onAutoInviteChange}
        title={t('web.workplace.autoInviteProjectMembersTitle')}
      />
      <div style={{ border: `1px solid ${'var(--border)'}`, borderRadius: boxR, background: 'var(--card)' }}>
        {loading ? <ProjectMembersListSkeleton /> : null}
        {empty ? (
          <div style={{ padding: '18px 16px', fontFamily: sans }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>
              {t('web.workplace.noProjectMembers')}
            </div>
            <p
              style={{
                margin: '4px 0 0',
                maxWidth: 560,
                fontSize: 12,
                lineHeight: 1.5,
                color: 'var(--muted-foreground)'
              }}
            >
              {t('web.workplace.noMembersHint')}
            </p>
          </div>
        ) : null}
        {!loading
          ? participants.map((participant, index) => (
              <ProjectMemberRow
                key={participant.id}
                member={members.find((candidate) => candidate.id === participant.id)}
                onOpenSettings={onOpenSettings}
                onRemove={onRemove}
                participant={participant}
                separated={index > 0}
              />
            ))
          : null}
      </div>
    </section>
  );
}

function ProjectMemberRow({
  member,
  onOpenSettings,
  onRemove,
  participant,
  separated
}: {
  member?: ProjectMember;
  onOpenSettings: (member: ProjectMember) => void;
  onRemove: (memberId: string) => void;
  participant: ProjectParticipant;
  separated: boolean;
}): React.ReactElement {
  const t = useT();
  const productIcon = participant.kind === 'agent' ? resolveProductIcon(participant) : undefined;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '32px minmax(0, 1fr) auto auto',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        borderTop: separated ? `1px solid ${'var(--border)'}` : 'none'
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
          badgeGap={4}
          icon={productIcon}
          iconSize={12}
          name={participant.name}
          nameStyle={{ fontFamily: sans, fontSize: 14, fontWeight: 600 }}
        />
      </div>
      <button
        className="workplace-action"
        disabled={!member}
        onClick={() => member && onOpenSettings(member)}
        style={{
          width: 36,
          height: 36,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `1px solid ${'var(--border)'}`,
          borderRadius: 8,
          background: 'transparent',
          color: member ? 'var(--foreground)' : 'var(--muted-foreground)'
        }}
        title={t('web.workplace.memberSettings')}
        type="button"
      >
        <HugeiconsIcon
          icon={ChevronRightIcon}
          size={14}
        />
      </button>
      <button
        className="workplace-action"
        onClick={() => onRemove(participant.id)}
        style={{
          width: 36,
          height: 36,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `1px solid ${'var(--destructive)'}`,
          borderRadius: 8,
          background: 'transparent',
          color: 'var(--destructive)'
        }}
        title={member ? t(projectMemberRemoveLabelKey(member.type)) : t('web.workplace.removeCliMember')}
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
