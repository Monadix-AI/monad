import type { ProjectController } from '../use-project';
import type { MeshAgentDraft, MeshAgentMemberDialogState } from './mesh-agent-member-dialog-model';

import { ChevronDownIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { entityAvatarUrl, meshAgentProjectMemberAvatarSeed } from '@monad/protocol';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@monad/ui';
import {
  AgentInstanceAvatar,
  workspaceMono as mono,
  workspaceSectionLabelStyle as sectionLabel
} from '@monad/ui/components/AgentAvatar';
import { useEffect, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import {
  ReasoningEffortControl,
  reasoningEffortOption,
  resolveReasoningEffort
} from '#/components/ReasoningEffortControl';
import { SwitchSetting } from '#/components/ui/switch-setting';
import { meshAgentModelDisplayName, meshAgentModelSupportsSpeed } from './mesh-agent-member-dialog-model';

export function MeshAgentMemberDialog({
  invite,
  onChange,
  onClose,
  onSave,
  room
}: {
  invite: MeshAgentMemberDialogState | null;
  onChange: (next: MeshAgentMemberDialogState | null) => void;
  onClose: () => void;
  onSave?: (invite: MeshAgentMemberDialogState) => Promise<unknown>;
  room: ProjectController;
}): React.ReactElement | null {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const resetSavingKey = invite ? `${invite.candidate.id}:${invite.editingMemberId ?? ''}` : '';
  useEffect(() => {
    resetSavingKey;
    setSaving(false);
  }, [resetSavingKey]);
  if (!invite) return null;
  const effortState = resolveReasoningEffort(invite.candidate.reasoningEfforts, invite.draft.reasoningEffort);
  const supportsFastMode = meshAgentModelSupportsSpeed(invite.candidate, invite.draft.modelId, 'fast');
  const field: React.CSSProperties = {
    width: '100%',
    border: `1px solid ${'var(--border)'}`,
    borderRadius: 8,
    background: 'var(--card)',
    color: 'var(--foreground)',
    fontFamily: mono,
    padding: '6px 8px'
  };
  const updateDraft = (draft: Partial<MeshAgentDraft>) => {
    onChange({ ...invite, draft: { ...invite.draft, ...draft } });
  };
  const save = () => {
    if (saving) return;
    setSaving(true);
    const savedInvite =
      supportsFastMode || invite.draft.speed === undefined
        ? invite
        : { ...invite, draft: { ...invite.draft, speed: undefined } };
    if (onSave) {
      void onSave(savedInvite)
        .then(onClose)
        .catch(() => setSaving(false));
      return;
    }
    const editingMemberId = invite.editingMemberId;
    if (editingMemberId) {
      void Promise.all([
        room.updateProjectMemberIdentity(editingMemberId, {
          displayName: invite.draft.displayName
        }),
        room.updateProjectMemberSettings(editingMemberId, {
          modelId: invite.draft.modelId,
          reasoningEffort: invite.draft.reasoningEffort,
          speed: savedInvite.draft.speed,
          customPrompt: invite.draft.customPrompt
        })
      ])
        .then(onClose)
        .catch(() => setSaving(false));
      return;
    }
    void room
      .addProjectMember(invite.candidate.type, invite.candidate.name, savedInvite.draft)
      .then(onClose)
      .catch(() => setSaving(false));
  };

  return (
    <Dialog
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent
        showCloseButton
        size="md"
      >
        <DialogHeader>
          <div className="cli-dialog-dense__header">
            <AgentInstanceAvatar
              agent={{
                ...invite.candidate,
                avatarUrl: entityAvatarUrl(
                  meshAgentProjectMemberAvatarSeed(
                    room.activeProjectId ?? room.projectId,
                    invite.draft.displayName?.trim() || invite.candidate.label
                  ),
                  room.source.avatarStyle
                ),
                name: invite.draft.displayName?.trim() || invite.candidate.label
              }}
              size={34}
            />
            <div className="cli-dialog-dense__identity">
              <div style={sectionLabel}>{t('web.workplace.configureCliMember')}</div>
              <DialogTitle className="cli-dialog-dense__title">{invite.candidate.label}</DialogTitle>
            </div>
          </div>
        </DialogHeader>
        <DialogBody className="cli-dialog-dense">
          <p className="cli-dialog-dense__hint">{t('web.workplace.managedMeshAgentAutomationHint')}</p>
          <label className="cli-dialog-dense__row">
            <span className="cli-dialog-dense__row-label">{t('web.workplace.instanceName')}</span>
            <input
              className="cli-dialog-dense__field"
              onChange={(event) => updateDraft({ displayName: event.target.value })}
              placeholder={invite.candidate.label}
              style={field}
              value={invite.draft.displayName ?? ''}
            />
          </label>
          <label className="cli-dialog-dense__row">
            <span className="cli-dialog-dense__row-label">{t('web.workplace.model')}</span>
            <select
              className="cli-dialog-dense__field"
              onChange={(event) => {
                const modelId = event.target.value || undefined;
                updateDraft({
                  modelId,
                  reasoningEffort: (invite.candidate.reasoningEfforts ?? []).includes(
                    invite.draft.reasoningEffort ?? ''
                  )
                    ? invite.draft.reasoningEffort
                    : undefined,
                  speed: meshAgentModelSupportsSpeed(invite.candidate, modelId, 'fast') ? invite.draft.speed : undefined
                });
              }}
              style={field}
              value={invite.draft.modelId ?? ''}
            >
              <option value="">{t('web.workplace.defaultModel')}</option>
              {invite.candidate.modelOptions.map((modelName) => (
                <option
                  key={modelName}
                  value={modelName}
                >
                  {invite.candidate.modelOptionDisplayNames?.[modelName] ?? meshAgentModelDisplayName(modelName)}
                </option>
              ))}
            </select>
          </label>
          {supportsFastMode ? (
            <SwitchSetting
              checked={invite.draft.speed === 'fast'}
              className="rounded-lg border px-2.5 py-2"
              description={t('web.workplace.enableFastModeHint')}
              onCheckedChange={(checked) => updateDraft({ speed: checked ? 'fast' : undefined })}
              title={t('web.workplace.enableFastMode')}
            />
          ) : null}
          {effortState.efforts.length > 0 ? (
            <div className="cli-dialog-dense__row">
              <span className="cli-dialog-dense__row-label">{t('web.workplace.reasoningEffort')}</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    className="w-fit gap-1.5 px-2 font-mono text-xs"
                    type="button"
                    variant="ghost"
                  >
                    {effortState.value
                      ? reasoningEffortOption(effortState.value).label
                      : t('web.workplace.reasoningEffort')}
                    <HugeiconsIcon
                      icon={ChevronDownIcon}
                      size={12}
                    />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-72 p-0"
                >
                  <ReasoningEffortControl
                    className="border-0 shadow-none"
                    onChange={(reasoningEffort) => updateDraft({ reasoningEffort })}
                    options={effortState.efforts.map(reasoningEffortOption)}
                    value={effortState.value}
                  />
                </PopoverContent>
              </Popover>
            </div>
          ) : null}
          <details className="cli-dialog-dense__advanced">
            <summary>{t('web.meshAgent.advanced')}</summary>
            <div className="cli-dialog-dense__advanced-body">
              <label
                className="cli-dialog-dense__row"
                style={{ alignItems: 'start' }}
              >
                <span
                  className="cli-dialog-dense__row-label"
                  style={{ paddingTop: 7 }}
                >
                  {t('web.workplace.customPrompt')}
                </span>
                <textarea
                  className="cli-dialog-dense__field"
                  onChange={(event) => updateDraft({ customPrompt: event.target.value })}
                  rows={3}
                  style={{ ...field, resize: 'vertical' }}
                  value={invite.draft.customPrompt ?? ''}
                />
              </label>
            </div>
          </details>
        </DialogBody>
        <DialogFooter>
          <Button
            onClick={onClose}
            variant="outline"
          >
            {t('web.common.cancel')}
          </Button>
          <Button
            disabled={saving}
            onClick={save}
          >
            {saving
              ? t('web.workplace.spawningAgentMember')
              : invite.editingMemberId
                ? t('web.workplace.saveAgentMember')
                : t('web.workplace.spawnAgentMember')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
