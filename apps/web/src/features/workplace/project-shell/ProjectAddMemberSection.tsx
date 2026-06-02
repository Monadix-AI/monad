import type { ProjectController } from '../use-project';

import { PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { meshAgentProductDisplayName } from '@monad/protocol';
import { Button } from '@monad/ui';
import { AgentInstanceAvatar, workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '#/components/ui/dialog';
import { isResolvedEmptyList } from '#/lib/async-list-state';
import { ProjectProvidersListSkeleton } from './ProjectSettingsListSkeletons';
import {
  initialProjectMemberTargetDialogState,
  type ProjectMemberTargetDialogEvent,
  projectMemberTargetDialogTransition
} from './project-member-target-dialog-model';

export type AvailableProjectMember = ProjectController['availableProjectMembers'][number];

export type ProjectMemberProviderGroup = {
  candidates: AvailableProjectMember[];
  enabled: boolean;
  icon?: AvailableProjectMember['icon'];
  id: string;
  interaction: 'direct-add' | 'select-existing' | 'spawn-new';
  label: string;
  type: AvailableProjectMember['type'];
};

export function projectMemberProviderInteraction(
  candidate: AvailableProjectMember
): ProjectMemberProviderGroup['interaction'] {
  if (candidate.type !== 'mesh-agent') return 'direct-add';
  return candidate.provider === 'monad' || candidate.provider === 'openclaw' || candidate.provider === 'hermes'
    ? 'select-existing'
    : 'spawn-new';
}

export function groupProjectMemberProviders(
  candidates: readonly AvailableProjectMember[]
): ProjectMemberProviderGroup[] {
  const groups = new Map<string, ProjectMemberProviderGroup>();
  for (const candidate of candidates) {
    const id =
      candidate.type === 'mesh-agent'
        ? `mesh-agent:${candidate.provider ?? candidate.name}`
        : `${candidate.type}:${candidate.name}`;
    const existing = groups.get(id);
    if (existing) {
      existing.candidates.push(candidate);
      existing.enabled ||= candidate.enabled;
      continue;
    }
    groups.set(id, {
      candidates: [candidate],
      enabled: candidate.enabled,
      icon: candidate.icon,
      id,
      interaction: projectMemberProviderInteraction(candidate),
      label:
        candidate.type === 'mesh-agent'
          ? meshAgentProductDisplayName(candidate.icon, candidate.provider, candidate.provider ?? candidate.name)
          : candidate.label,
      type: candidate.type
    });
  }
  return [...groups.values()];
}

export function projectMemberProviderAction(group: Pick<ProjectMemberProviderGroup, 'enabled'>): {
  disabled: boolean;
  labelKey: 'web.workplace.addMember';
} {
  return {
    disabled: !group.enabled,
    labelKey: 'web.workplace.addMember'
  };
}

function ProviderRow({
  group,
  index,
  onAdd,
  onOpen
}: {
  group: ProjectMemberProviderGroup;
  index: number;
  onAdd: (candidate: AvailableProjectMember) => void;
  onOpen: (groupId: string) => void;
}): React.ReactElement {
  const t = useT();
  const action = projectMemberProviderAction(group);
  const providerMeta =
    group.interaction === 'select-existing'
      ? t('web.workplace.providerAvailableAgentCount', { count: group.candidates.length })
      : group.type === 'mesh-agent'
        ? t('web.workplace.meshAgentProvider')
        : t('web.workplace.acpProvider');
  return (
    <div
      className="project-provider-row"
      style={{ borderTop: index === 0 ? 'none' : `1px solid ${'var(--border)'}` }}
    >
      <AgentInstanceAvatar
        agent={{ icon: group.icon, name: group.label }}
        bare
        size={34}
      />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: sans,
            fontSize: 14,
            fontWeight: 620,
            color: 'var(--foreground)'
          }}
          title={group.label}
        >
          {group.label}
        </div>
        <div style={{ marginTop: 2, fontFamily: sans, fontSize: 12, color: 'var(--muted-foreground)' }}>
          {providerMeta} · {group.enabled ? t('web.workplace.available') : t('web.workplace.disabledInStudio')}
        </div>
      </div>
      <div className="project-provider-actions">
        {group.interaction === 'select-existing' ? (
          <button
            className="workplace-action"
            disabled={action.disabled}
            onClick={() => onOpen(group.id)}
            style={{
              minHeight: 36,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              border: `1px solid ${group.enabled ? 'var(--accent-blue)' : 'var(--border)'}`,
              borderRadius: 8,
              background: group.enabled ? 'var(--accent-blue-soft)' : 'var(--secondary)',
              color: group.enabled ? 'var(--accent-blue)' : 'var(--muted-foreground)',
              cursor: group.enabled ? 'pointer' : 'not-allowed',
              fontFamily: mono,
              fontSize: 11,
              fontWeight: 600,
              opacity: group.enabled ? 1 : 0.68,
              padding: '7px 10px',
              whiteSpace: 'nowrap'
            }}
            title={group.enabled ? undefined : t('web.workplace.enableAgentFirst')}
            type="button"
          >
            <HugeiconsIcon
              icon={PlusSignIcon}
              size={14}
            />
            {t(action.labelKey)}
          </button>
        ) : (
          group.candidates.map((candidate) => (
            <button
              aria-label={t('web.workplace.addCandidate', { label: candidate.label })}
              className="workplace-action"
              disabled={!candidate.enabled}
              key={candidate.id}
              onClick={() => onAdd(candidate)}
              style={{
                minHeight: 36,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                border: `1px solid ${candidate.enabled ? 'var(--accent-blue)' : 'var(--border)'}`,
                borderRadius: 8,
                background: candidate.enabled ? 'var(--accent-blue-soft)' : 'var(--secondary)',
                color: candidate.enabled ? 'var(--accent-blue)' : 'var(--muted-foreground)',
                cursor: candidate.enabled ? 'pointer' : 'not-allowed',
                fontFamily: mono,
                fontSize: 11,
                fontWeight: 600,
                opacity: candidate.enabled ? 1 : 0.68,
                padding: '7px 10px',
                whiteSpace: 'nowrap'
              }}
              title={candidate.enabled ? undefined : t('web.workplace.enableAgentFirst')}
              type="button"
            >
              <HugeiconsIcon
                icon={PlusSignIcon}
                size={14}
              />
              {group.candidates.length > 1 ? candidate.label : t('web.workplace.addMember')}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export function ProjectAddMemberSection({
  candidates,
  loading,
  onAdd,
  promoted = false
}: {
  candidates: AvailableProjectMember[];
  loading: boolean;
  onAdd: (candidate: AvailableProjectMember) => void;
  promoted?: boolean;
}): React.ReactElement {
  const t = useT();
  const groups = groupProjectMemberProviders(candidates);
  const [dialogState, setDialogState] = useState(initialProjectMemberTargetDialogState);
  const activeGroup =
    groups.find((group) => group.id === dialogState.openGroupId && group.interaction === 'select-existing') ?? null;
  const selectedCandidate =
    activeGroup?.candidates.find((candidate) => candidate.id === dialogState.selectedCandidateId) ?? null;

  const dispatchDialog = (event: ProjectMemberTargetDialogEvent) => {
    const result = projectMemberTargetDialogTransition(dialogState, event);
    setDialogState(result.state);
    return result.effect;
  };

  const confirmTarget = () => {
    const effect = dispatchDialog({ type: 'confirm' });
    if (!effect || !activeGroup) return;
    const candidate = activeGroup.candidates.find((item) => item.id === effect.candidateId);
    if (candidate?.enabled) onAdd(candidate);
  };

  return (
    <>
      <div
        style={{
          border: `1px solid ${promoted ? 'color-mix(in srgb, var(--accent-blue) 48%, var(--border))' : 'var(--border)'}`,
          borderRadius: 12,
          background: promoted ? 'color-mix(in srgb, var(--accent-blue) 5%, var(--card))' : 'var(--card)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
      >
        {loading ? <ProjectProvidersListSkeleton /> : null}
        {isResolvedEmptyList({ isLoading: loading, itemCount: groups.length }) ? (
          <div style={{ padding: '18px 16px', fontFamily: sans }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>
              {t('web.workplace.noAvailableProviders')}
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
              {t('web.workplace.noAvailableMembers')}
            </p>
          </div>
        ) : null}
        {!loading
          ? groups.map((group, index) => (
              <ProviderRow
                group={group}
                index={index}
                key={group.id}
                onAdd={onAdd}
                onOpen={(groupId) => dispatchDialog({ type: 'open', groupId })}
              />
            ))
          : null}
      </div>

      <Dialog
        onOpenChange={(open) => !open && dispatchDialog({ type: 'dismiss' })}
        open={activeGroup !== null}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>
              {t('web.workplace.selectMemberTargetTitle', { provider: activeGroup?.label ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('web.workplace.selectMemberTargetDescription')}</DialogDescription>
          </DialogHeader>
          <DialogBody
            aria-label={t('web.workplace.selectMemberTargetDescription')}
            className="grid gap-2"
            role="radiogroup"
          >
            {activeGroup?.candidates.map((candidate) => {
              const selected = candidate.id === selectedCandidate?.id;
              return (
                <label
                  className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors"
                  key={candidate.id}
                  style={{
                    borderColor: selected ? 'var(--accent-blue)' : 'var(--border)',
                    background: selected ? 'var(--accent-blue-soft)' : 'var(--card)',
                    cursor: candidate.enabled ? 'pointer' : 'not-allowed',
                    opacity: candidate.enabled ? 1 : 0.55
                  }}
                  title={candidate.enabled ? undefined : t('web.workplace.enableAgentFirst')}
                >
                  <AgentInstanceAvatar
                    agent={{ icon: candidate.icon, name: candidate.label }}
                    bare
                    size={32}
                  />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontFamily: sans,
                        fontSize: 13,
                        fontWeight: 620,
                        color: 'var(--foreground)'
                      }}
                    >
                      {candidate.label}
                    </span>
                    <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: 'var(--muted-foreground)' }}>
                      {candidate.enabled ? candidate.tag : t('web.workplace.enableAgentFirst')}
                    </span>
                  </span>
                  <input
                    aria-label={t('web.workplace.selectMemberTarget', { label: candidate.label })}
                    checked={selected}
                    disabled={!candidate.enabled}
                    name="project-member-target"
                    onChange={() =>
                      dispatchDialog({ type: 'select', candidateId: candidate.id, enabled: candidate.enabled })
                    }
                    style={{
                      width: 16,
                      height: 16,
                      accentColor: 'var(--accent-blue)',
                      flex: '0 0 auto'
                    }}
                    type="radio"
                  />
                </label>
              );
            })}
          </DialogBody>
          <DialogFooter>
            <Button
              onClick={() => dispatchDialog({ type: 'dismiss' })}
              variant="outline"
            >
              {t('web.cancel')}
            </Button>
            <Button
              disabled={!selectedCandidate?.enabled}
              onClick={confirmTarget}
            >
              {t('web.workplace.addMember')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
