import type { ProjectController } from '../use-project';

import { workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';

import { useT } from '@/components/I18nProvider';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

type ProjectMember = ProjectController['projectMembers'][number];

function MemberSettings({ member, room }: { member: ProjectMember; room: ProjectController }): React.ReactElement {
  const t = useT();
  const settings = member.settings ?? {};
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
  const label: React.CSSProperties = {
    fontFamily: mono,
    fontSize: 10,
    color: 'var(--muted-foreground)'
  };
  const toggleStyle = (active: boolean): React.CSSProperties => ({
    border: `1px solid ${active ? 'var(--accent-blue)' : 'var(--border)'}`,
    borderRadius: 999,
    background: active ? 'var(--accent-blue-soft)' : 'transparent',
    color: active ? 'var(--accent-blue)' : 'var(--muted-foreground)',
    fontFamily: mono,
    fontSize: 11,
    padding: '4px 9px'
  });

  if (member.type === 'monad') {
    return (
      <div style={{ fontFamily: sans, fontSize: 13, color: 'var(--muted-foreground)' }}>
        {t('web.workplace.managedByMonad')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={label}>{t('web.workplace.cwdOverride')}</span>
        <input
          defaultValue={settings.cwd ?? ''}
          onBlur={(event) => void room.updateProjectMemberSettings(member.id, { cwd: event.target.value.trim() })}
          placeholder={room.workdir.path ?? t('web.workplace.absolutePathPlaceholder')}
          style={field}
        />
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <button
          className="workplace-action"
          onClick={() => void room.updateProjectMemberSettings(member.id, { osSandbox: !settings.osSandbox })}
          style={toggleStyle(settings.osSandbox === true)}
          type="button"
        >
          {t('web.workplace.osSandbox')} {settings.osSandbox ? t('web.acp.osSandboxOn') : t('web.acp.osSandboxOff')}
        </button>
        <button
          className="workplace-action"
          onClick={() => void room.updateProjectMemberSettings(member.id, { forwardMcp: !settings.forwardMcp })}
          style={toggleStyle(settings.forwardMcp === true)}
          type="button"
        >
          {t('web.workplace.mcpSharing')} {settings.forwardMcp ? t('web.acp.osSandboxOn') : t('web.acp.osSandboxOff')}
        </button>
      </div>
    </div>
  );
}

export function ProjectMemberSettingsDialog({
  member,
  onClose,
  room
}: {
  member: ProjectMember | null;
  onClose: () => void;
  room: ProjectController;
}): React.ReactElement | null {
  const t = useT();
  if (!member) return null;
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
          <DialogTitle style={{ fontFamily: sans, fontSize: 18, fontWeight: 650 }}>
            {t('web.workplace.memberSettings')}
          </DialogTitle>
          <MemberSettings
            member={member}
            room={room}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
