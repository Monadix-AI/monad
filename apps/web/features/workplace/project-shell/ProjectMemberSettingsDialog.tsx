import type { ProjectController } from '../use-project';

import { Dialog, DialogContent, DialogTitle } from '@monad/ui';
import { workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';

import { useT } from '@/components/I18nProvider';
import { useExternalAgentSettings } from '@/hooks/use-external-agent-settings';
import { canDisableAutopilot } from '../../studio/third-party-agents/external-agent-settings-model';

type ProjectMember = ProjectController['projectMembers'][number];

function MemberSettings({ member, room }: { member: ProjectMember; room: ProjectController }): React.ReactElement {
  const t = useT();
  const { agents, presets } = useExternalAgentSettings();
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
      {member.type === 'external-agent' ? (
        <ExternalAgentApprovalSetting
          agents={agents}
          label={label}
          member={member}
          presets={presets}
          room={room}
          toggleStyle={toggleStyle}
        />
      ) : null}
    </div>
  );
}

/** Per-member approval mode for a managed external agent. Dangerous mode ON = autopilot (the agent
 *  runs its provider's dangerous/full-auto flags). Dangerous mode OFF = delegate provider approvals to
 *  the human — only offered when the provider's adapter can actually proxy approvals, mirroring the
 *  agent-template editor's gate. */
function ExternalAgentApprovalSetting({
  agents,
  presets,
  member,
  room,
  label,
  toggleStyle
}: {
  agents: ReturnType<typeof useExternalAgentSettings>['agents'];
  presets: ReturnType<typeof useExternalAgentSettings>['presets'];
  member: ProjectMember;
  room: ProjectController;
  label: React.CSSProperties;
  toggleStyle: (active: boolean) => React.CSSProperties;
}): React.ReactElement {
  const t = useT();
  const templateName = member.templateName ?? member.name;
  const agent = agents.find((candidate) => candidate.name === templateName);
  const preset = agent ? presets.find((candidate) => candidate.provider === agent.provider) : undefined;
  const canProxy = agent ? canDisableAutopilot(agent, preset) : false;
  const templateDangerous = agent?.allowAutopilot ?? true;
  const dangerous = canProxy ? (member.settings?.allowAutopilot ?? templateDangerous) : true;
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={label}>{t('web.externalAgent.autopilot')}</span>
      <button
        className="workplace-action"
        disabled={!canProxy}
        onClick={() => void room.updateProjectMemberSettings(member.id, { allowAutopilot: !dangerous })}
        style={{ ...toggleStyle(dangerous), alignSelf: 'flex-start', opacity: canProxy ? 1 : 0.6 }}
        type="button"
      >
        {dangerous ? t('web.acp.osSandboxOn') : t('web.acp.osSandboxOff')}
      </button>
      <span style={{ ...label, opacity: 0.85 }}>
        {canProxy ? t('web.externalAgent.autopilotHint') : t('web.externalAgent.approvalProxyUnavailable')}
      </span>
    </label>
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
