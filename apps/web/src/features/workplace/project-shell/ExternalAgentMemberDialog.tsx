import type { ExternalAgentAppServerTransport } from '@monad/protocol';
import type { ProjectController } from '../use-project';
import type { ExternalAgentDraft, ExternalAgentMemberDialogState } from './external-agent-member-dialog-model';

import { ChevronDownIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { entityAvatarUrl, externalAgentProjectMemberAvatarSeed } from '@monad/protocol';
import { Button, Dialog, DialogContent, DialogTitle, Popover, PopoverContent, PopoverTrigger, Switch } from '@monad/ui';
import {
  AgentInstanceAvatar,
  workspaceMono as mono,
  workspaceSans as sans,
  workspaceSectionLabelStyle as sectionLabel
} from '@monad/ui/components/AgentAvatar';
import { useEffect, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import {
  defaultReasoningEffort,
  ReasoningEffortControl,
  reasoningEffortOption
} from '#/components/ReasoningEffortControl';
import { externalAgentModelDisplayName } from './external-agent-member-dialog-model';

export function ExternalAgentMemberDialog({
  invite,
  onChange,
  onClose,
  onSave,
  room
}: {
  invite: ExternalAgentMemberDialogState | null;
  onChange: (next: ExternalAgentMemberDialogState | null) => void;
  onClose: () => void;
  onSave?: (invite: ExternalAgentMemberDialogState) => Promise<unknown>;
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
  const updateDraft = (draft: Partial<ExternalAgentDraft>) => {
    onChange({ ...invite, draft: { ...invite.draft, ...draft } });
  };
  const save = () => {
    if (saving) return;
    setSaving(true);
    if (onSave) {
      void onSave(invite)
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
          speed: invite.draft.speed,
          appServerTransport: invite.draft.appServerTransport,
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
      onOpenChange={(open: boolean) => {
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
                  externalAgentProjectMemberAvatarSeed(
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
            {t('web.workplace.managedExternalAgentAutomationHint')}
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
                    {invite.candidate.modelOptionDisplayNames?.[modelName] ?? externalAgentModelDisplayName(modelName)}
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
            <details
              style={{ border: `1px solid ${'var(--border)'}`, borderRadius: 8, background: 'var(--background)' }}
            >
              <summary
                style={{
                  fontFamily: mono,
                  fontSize: 11,
                  fontWeight: 650,
                  padding: '8px 10px'
                }}
              >
                {t('web.externalAgent.advanced')}
              </summary>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  borderTop: `1px solid ${'var(--border)'}`,
                  padding: 10
                }}
              >
                {(invite.candidate.supportedAppServerTransports ?? []).length > 1 ? (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--muted-foreground)' }}>
                      {t('web.workplace.appServerTransport')}
                    </span>
                    <select
                      onChange={(event) =>
                        updateDraft({
                          appServerTransport: (event.target.value || undefined) as
                            | ExternalAgentAppServerTransport
                            | undefined
                        })
                      }
                      style={field}
                      value={invite.draft.appServerTransport ?? ''}
                    >
                      <option value="">{t('web.workplace.appServerTransportDefault')}</option>
                      {(invite.candidate.supportedAppServerTransports ?? []).map((transport) => (
                        <option
                          key={transport}
                          value={transport}
                        >
                          {transport}
                        </option>
                      ))}
                    </select>
                  </label>
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
            </details>
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
