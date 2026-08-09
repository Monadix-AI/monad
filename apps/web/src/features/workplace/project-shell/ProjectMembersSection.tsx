import type { AvatarStyle } from '@monad/protocol';
import type { ProjectController } from '../use-project';

import { ChevronRightIcon, MinusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { entityAvatarUrl, workplaceProjectMemberAvatarSeed } from '@monad/protocol';
import { Confirm } from '@monad/ui';
import {
  AgentIdentity,
  AgentInstanceAvatar,
  workspaceBoxRadius as boxR,
  workspaceMono as mono,
  resolveProductIcon,
  workspaceSans as sans
} from '@monad/ui/components/AgentAvatar';
import { useEffect, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { RefreshButton } from '#/components/RefreshButton';
import { toast } from '#/components/ToastProvider';
import { isResolvedEmptyList } from '#/lib/async-list-state';
import { ProjectMembersListSkeleton } from './ProjectSettingsListSkeletons';

type ProjectMember = ProjectController['projectMembers'][number];
type AvailableProjectMember = ProjectController['availableProjectMembers'][number];

function projectMemberRemoveLabelKey(
  type: ProjectMember['type']
): 'web.workplace.removeAcpMember' | 'web.workplace.removeCliMember' {
  return type === 'acp' ? 'web.workplace.removeAcpMember' : 'web.workplace.removeCliMember';
}

export function ProjectMembersSection({
  avatarStyle,
  candidates,
  loading,
  members,
  onOpenSettings,
  onRemove,
  onRefresh,
  projectId,
  refreshing
}: {
  avatarStyle?: AvatarStyle;
  candidates: ProjectController['availableProjectMembers'];
  loading: boolean;
  members: ProjectController['projectMembers'];
  onOpenSettings: (member: ProjectMember) => void;
  onRemove: (memberId: string) => Promise<void>;
  onRefresh: () => void;
  projectId: string;
  refreshing: boolean;
}): React.ReactElement {
  const t = useT();
  const [memberToRemove, setMemberToRemove] = useState<ProjectMember | null>(null);
  const [optimisticallyRemovedIds, setOptimisticallyRemovedIds] = useState<Set<string>>(() => new Set());
  const visibleMembers = members.filter((member) => !optimisticallyRemovedIds.has(member.id));
  const empty = isResolvedEmptyList({ isLoading: loading, itemCount: visibleMembers.length });

  useEffect(() => {
    setOptimisticallyRemovedIds((current) => {
      const pending = new Set([...current].filter((id) => members.some((member) => member.id === id)));
      return pending.size === current.size ? current : pending;
    });
  }, [members]);

  const removeMember = (member: ProjectMember) => {
    setOptimisticallyRemovedIds((current) => new Set(current).add(member.id));
    setMemberToRemove(null);
    void onRemove(member.id).catch((error) => {
      setOptimisticallyRemovedIds((current) => {
        const restored = new Set(current);
        restored.delete(member.id);
        return restored;
      });
      toast.error(t('web.workplace.removeProjectMemberFailed'), { detail: error });
    });
  };

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
            {visibleMembers.length}
          </span>
        </div>
      </div>
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
          ? visibleMembers.map((member, index) => (
              <ProjectMemberRow
                avatarStyle={avatarStyle}
                candidate={candidates.find(
                  (candidate) => candidate.type === member.type && candidate.name === member.name
                )}
                key={member.id}
                member={member}
                onOpenSettings={onOpenSettings}
                onRemove={() => setMemberToRemove(member)}
                projectId={projectId}
                removalPending={optimisticallyRemovedIds.size > 0}
                separated={index > 0}
              />
            ))
          : null}
      </div>
      <Confirm
        cancelLabel={t('web.common.cancel')}
        confirmLabel={t('web.workplace.removeProjectMemberConfirmAction')}
        confirmVariant="destructive"
        description={
          memberToRemove
            ? t('web.workplace.removeProjectMemberConfirmDescription', {
                name: memberToRemove.displayName ?? memberToRemove.name
              })
            : undefined
        }
        onConfirm={() => {
          if (memberToRemove) removeMember(memberToRemove);
        }}
        onOpenChange={(open) => {
          if (!open) setMemberToRemove(null);
        }}
        open={memberToRemove !== null}
        title={t('web.workplace.removeProjectMember')}
      />
    </section>
  );
}

function ProjectMemberRow({
  avatarStyle,
  candidate,
  member,
  onOpenSettings,
  onRemove,
  projectId,
  removalPending,
  separated
}: {
  avatarStyle?: AvatarStyle;
  candidate?: AvailableProjectMember;
  member: ProjectMember;
  onOpenSettings: (member: ProjectMember) => void;
  onRemove: () => void;
  projectId: string;
  removalPending: boolean;
  separated: boolean;
}): React.ReactElement {
  const t = useT();
  const name = member.displayName ?? candidate?.label ?? member.name;
  const avatarSeed =
    member.type === 'mesh-agent' ? workplaceProjectMemberAvatarSeed(projectId, member) : `acp:${member.name}`;
  const agent = { avatarUrl: entityAvatarUrl(avatarSeed, avatarStyle), name };
  const productIcon = resolveProductIcon({ icon: candidate?.icon, name });

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
          agent={agent}
          size={30}
        />
      </div>
      <div style={{ minWidth: 0 }}>
        <AgentIdentity
          badgeGap={4}
          icon={productIcon}
          iconSize={12}
          name={name}
          nameStyle={{ fontFamily: sans, fontSize: 14, fontWeight: 600 }}
        />
      </div>
      <button
        className="workplace-action"
        onClick={() => onOpenSettings(member)}
        style={{
          width: 36,
          height: 36,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `1px solid ${'var(--border)'}`,
          borderRadius: 8,
          background: 'transparent',
          color: 'var(--foreground)'
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
        disabled={removalPending}
        onClick={onRemove}
        style={{
          width: 36,
          height: 36,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `1px solid ${'var(--destructive)'}`,
          borderRadius: 8,
          background: 'transparent',
          color: removalPending ? 'var(--muted-foreground)' : 'var(--destructive)'
        }}
        title={t(projectMemberRemoveLabelKey(member.type))}
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
