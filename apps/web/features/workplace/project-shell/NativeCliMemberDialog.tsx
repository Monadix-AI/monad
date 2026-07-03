import { ChevronDownIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { entityAvatarUrl } from '@monad/protocol';
import { Button, Switch } from '@monad/ui';
import { useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import {
  defaultReasoningEffort,
  ReasoningEffortControl,
  reasoningEffortOption
} from '@/components/ReasoningEffortControl';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AgentInstanceAvatar } from '../Bits';
import { mono, sans, sectionLabel } from '../styles';
import { nativeCliAvatarSeed, type ProjectController } from '../use-project';

type AvailableProjectMember = ProjectController['availableProjectMembers'][number];
type ProjectMember = ProjectController['projectMembers'][number];

type NativeCliDraft = {
  displayName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  customPrompt?: string;
};

export type NativeCliMemberDialogState = {
  candidate: AvailableProjectMember;
  draft: NativeCliDraft;
  editingMemberId?: string;
};

export function nativeCliMemberDialogStateForMember(
  room: ProjectController,
  member: ProjectMember
): NativeCliMemberDialogState | null {
  if (member.type !== 'native-cli') return null;
  const templateName = member.templateName ?? member.name;
  const candidate = room.availableProjectMembers.find(
    (option) => option.type === 'native-cli' && option.name === templateName
  );
  if (!candidate) return null;
  const settings = member.settings ?? {};
  return {
    candidate,
    editingMemberId: member.id,
    draft: {
      displayName: member.displayName ?? member.name,
      modelId: settings.modelId,
      reasoningEffort: settings.reasoningEffort,
      speed: settings.speed,
      customPrompt: settings.customPrompt
    }
  };
}

function modelDisplayName(modelName: string): string {
  if (modelName.startsWith('gpt-')) {
    return modelName
      .split('-')
      .map((part, index) => (index === 0 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
      .join('-');
  }
  if (modelName.startsWith('claude-')) {
    return modelName
      .replace(/^claude-/, '')
      .replace(/-(\d)-(\d)$/, ' $1.$2')
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
  return modelName;
}

export function NativeCliMemberDialog({
  invite,
  onChange,
  onClose,
  room
}: {
  invite: NativeCliMemberDialogState | null;
  onChange: (next: NativeCliMemberDialogState | null) => void;
  onClose: () => void;
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
  const field: React.CSSProperties = {
    width: '100%',
    border: `1px solid ${'var(--border)'}`,
    borderRadius: 8,
    background: 'var(--card)',
    color: 'var(--foreground)',
    fontFamily: mono,
    fontSize: 12,
    padding: '6px 8px'
  };
  const updateDraft = (draft: Partial<NativeCliDraft>) => {
    onChange({ ...invite, draft: { ...invite.draft, ...draft } });
  };
  const save = () => {
    if (saving) return;
    setSaving(true);
    const editingMemberId = invite.editingMemberId;
    if (editingMemberId) {
      void Promise.all([
        room.updateProjectMemberIdentity(editingMemberId, {
          displayName: invite.draft.displayName
        }),
        room.updateProjectMemberSettings(editingMemberId, {
          modelId: invite.draft.modelId,
          reasoningEffort: invite.draft.reasoningEffort,
          speed: invite.draft.speed,
          customPrompt: invite.draft.customPrompt
        })
      ])
        .then(onClose)
        .catch(() => setSaving(false));
      return;
    }
    void room
      .addProjectMember(invite.candidate.type, invite.candidate.name, invite.draft)
      .then(onClose)
      .catch(() => setSaving(false));
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent
        className="max-w-lg"
        showCloseButton
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <AgentInstanceAvatar
              agent={{
                ...invite.candidate,
                avatarUrl: entityAvatarUrl(
                  nativeCliAvatarSeed(
                    room.activeProjectId ?? room.projectId,
                    invite.draft.displayName?.trim() || invite.candidate.label
                  ),
                  room.source.avatarStyle
                ),
                name: invite.draft.displayName?.trim() || invite.candidate.label
              }}
              size={38}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={sectionLabel}>{t('web.workplace.configureCliMember')}</div>
              <DialogTitle
                style={{
                  marginTop: 4,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: sans,
                  fontSize: 18,
                  fontWeight: 650
                }}
              >
                {invite.candidate.label}
              </DialogTitle>
            </div>
          </div>
          <p style={{ margin: 0, fontFamily: sans, fontSize: 12, lineHeight: 1.45, color: 'var(--muted-foreground)' }}>
            {t('web.workplace.managedNativeCliAutomationHint')}
          </p>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              border: `1px solid ${'var(--border)'}`,
              borderRadius: 12,
              background: 'var(--card)',
              padding: 12
            }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--muted-foreground)' }}>
                {t('web.workplace.instanceName')}
              </span>
              <input
                onChange={(event) => updateDraft({ displayName: event.target.value })}
                placeholder={invite.candidate.label}
                style={field}
                value={invite.draft.displayName ?? ''}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--muted-foreground)' }}>
                {t('web.workplace.model')}
              </span>
              <select
                onChange={(event) =>
                  updateDraft({
                    modelId: event.target.value || undefined,
                    reasoningEffort: (invite.candidate.reasoningEfforts ?? []).includes(
                      invite.draft.reasoningEffort ?? ''
                    )
                      ? invite.draft.reasoningEffort
                      : undefined
                  })
                }
                style={field}
                value={invite.draft.modelId ?? ''}
              >
                <option value="">{t('web.workplace.defaultModel')}</option>
                {invite.candidate.modelOptions.map((modelName) => (
                  <option
                    key={modelName}
                    value={modelName}
                  >
                    {modelDisplayName(modelName)}
                  </option>
                ))}
              </select>
            </label>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                border: `1px solid ${'var(--border)'}`,
                borderRadius: 8,
                padding: '8px 10px'
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span style={{ fontFamily: sans, fontSize: 13, fontWeight: 500, color: 'var(--foreground)' }}>
                  {t('web.workplace.enableFastMode')}
                </span>
                <span style={{ fontFamily: sans, fontSize: 11, color: 'var(--muted-foreground)' }}>
                  {t('web.workplace.enableFastModeHint')}
                </span>
              </div>
              <Switch
                checked={invite.draft.speed === 'fast'}
                onCheckedChange={(checked) => updateDraft({ speed: checked ? 'fast' : undefined })}
              />
            </div>
            {(invite.candidate.reasoningEfforts ?? []).length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--muted-foreground)' }}>
                  {t('web.workplace.reasoningEffort')}
                </span>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      className="w-fit gap-1.5 px-2 font-mono text-xs"
                      type="button"
                      variant="ghost"
                    >
                      {
                        reasoningEffortOption(
                          invite.draft.reasoningEffort ??
                            defaultReasoningEffort(invite.candidate.reasoningEfforts) ??
                            ''
                        ).label
                      }
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
                      options={(invite.candidate.reasoningEfforts ?? []).map(reasoningEffortOption)}
                      value={invite.draft.reasoningEffort ?? defaultReasoningEffort(invite.candidate.reasoningEfforts)}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            ) : null}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--muted-foreground)' }}>
                {t('web.workplace.customPrompt')}
              </span>
              <textarea
                onChange={(event) => updateDraft({ customPrompt: event.target.value })}
                rows={4}
                style={{ ...field, resize: 'vertical' }}
                value={invite.draft.customPrompt ?? ''}
              />
            </label>
          </div>
          <button
            className="workplace-action"
            disabled={saving}
            onClick={save}
            style={{
              width: '100%',
              minHeight: 32,
              border: `1px solid ${saving ? 'color-mix(in srgb, var(--accent-blue) 72%, var(--foreground))' : 'var(--accent-blue)'}`,
              borderRadius: 8,
              background: saving
                ? 'color-mix(in srgb, var(--accent-blue) 82%, var(--background))'
                : 'var(--accent-blue)',
              color: 'var(--primary-foreground)',
              fontFamily: mono,
              fontSize: 12,
              fontWeight: 650,
              opacity: saving ? 0.92 : 1,
              padding: '7px 12px'
            }}
            type="button"
          >
            {saving
              ? t('web.workplace.spawningAgentMember')
              : invite.editingMemberId
                ? t('web.workplace.saveAgentMember')
                : t('web.workplace.spawnAgentMember')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
