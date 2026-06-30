import type { ProjectController } from './use-project';

import { ChevronDown, ChevronRight, Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Avatar, MiniTag, PresenceBadge } from './Bits';
import { boxR, mono, sans, sectionLabel } from './styles';

type Translate = ReturnType<typeof useT>;

function removeLabel(id: string, t: Translate): string {
  if (id.startsWith('native-cli:')) return t('web.workplace.removeCliMember');
  if (id.startsWith('acp:')) return t('web.workplace.removeAcpMember');
  return t('web.workplace.managedByMonad');
}

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
    cursor: 'pointer',
    fontFamily: mono,
    fontSize: 11,
    padding: '4px 9px'
  });

  if (member.type === 'native-cli') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '0 12px 12px 54px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={label}>{t('web.workplace.launchMode')}</span>
          <select
            onChange={(event) =>
              void room.updateProjectMemberSettings(member.id, {
                launchMode: event.target.value as NonNullable<typeof settings.launchMode>
              })
            }
            style={field}
            value={settings.launchMode ?? 'pty'}
          >
            <option value="pty">{t('web.workplace.launchModePty')}</option>
            <option value="json-stream">{t('web.workplace.launchModeJsonStream')}</option>
            <option value="app-server">{t('web.workplace.launchModeAppServer')}</option>
            <option value="remote-control">{t('web.workplace.launchModeRemoteControl')}</option>
          </select>
        </label>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 12px 12px 54px' }}>
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

export function ProjectSettings({
  room,
  onClose,
  initialMemberId = null
}: {
  room: ProjectController;
  onClose: () => void;
  initialMemberId?: string | null;
}): React.ReactElement {
  const t = useT();
  const [expanded, setExpanded] = useState<string | null>(initialMemberId);
  const projectParticipants = room.participants.filter((participant) => participant.id !== 'monad');

  useEffect(() => {
    if (initialMemberId) setExpanded(initialMemberId);
  }, [initialMemberId]);

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent
        className="flex h-[min(780px,calc(100vh-1.5rem))] min-w-0 max-w-3xl flex-col overflow-hidden p-0 sm:max-w-3xl"
        showCloseButton
      >
        <div style={{ borderBottom: `1px solid ${'var(--border)'}`, padding: '16px 18px 14px' }}>
          <div style={{ ...sectionLabel, marginBottom: 6 }}>{t('web.workplace.projectSettingsLabel')}</div>
          <DialogTitle style={{ fontFamily: sans, fontSize: 18, fontWeight: 650, lineHeight: 1.25 }}>
            {t('web.workplace.membersTitle')}
          </DialogTitle>
          <p style={{ marginTop: 5, maxWidth: 560, fontFamily: sans, fontSize: 13, color: 'var(--muted-foreground)' }}>
            {t('web.workplace.membersDescription')}
          </p>
        </div>

        <div
          className="scwf-scroll"
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column' }}
        >
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={sectionLabel}>{t('web.workplace.currentMembers')}</div>
            <div style={{ border: `1px solid ${'var(--border)'}`, borderRadius: boxR, background: 'var(--card)' }}>
              {room.participants.map((participant, index) => {
                const isMonad = participant.id === 'monad';
                const member = room.projectMembers.find((candidate) => candidate.id === participant.id);
                const isExpanded = expanded === participant.id;
                return (
                  <div key={participant.id}>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '32px minmax(0, 1fr) auto auto',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 12px',
                        borderTop: index === 0 ? 'none' : `1px solid ${'var(--border)'}`
                      }}
                    >
                      <div style={{ position: 'relative', flex: 'none' }}>
                        <Avatar
                          av={participant.av}
                          icon={participant.icon}
                          kind={participant.kind}
                          size={30}
                        />
                        <PresenceBadge presence={participant.presence} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <span
                            style={{
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              fontFamily: sans,
                              fontSize: 14,
                              fontWeight: 600
                            }}
                          >
                            {participant.name}
                          </span>
                          <MiniTag tag={participant.tag} />
                        </div>
                        <div style={{ marginTop: 2, fontFamily: mono, fontSize: 10, color: 'var(--muted-foreground)' }}>
                          {participant.role ?? t('web.workplace.roleAgent')} · {participant.presence}
                        </div>
                      </div>
                      <button
                        className="workplace-action"
                        disabled={!member}
                        onClick={() => setExpanded(isExpanded ? null : participant.id)}
                        style={{
                          width: 28,
                          height: 28,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          border: `1px solid ${'var(--border)'}`,
                          borderRadius: 8,
                          background: isExpanded ? 'var(--secondary)' : 'transparent',
                          color: member ? 'var(--foreground)' : 'var(--muted-foreground)',
                          cursor: member ? 'pointer' : 'default'
                        }}
                        title={member ? t('web.workplace.memberSettings') : t('web.workplace.managedByMonad')}
                        type="button"
                      >
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                      <button
                        className="workplace-action"
                        disabled={isMonad}
                        onClick={() => void room.removeProjectMember(participant.id)}
                        style={{
                          width: 28,
                          height: 28,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          border: `1px solid ${isMonad ? 'var(--border)' : 'var(--destructive)'}`,
                          borderRadius: 8,
                          background: isMonad ? 'var(--secondary)' : 'transparent',
                          color: isMonad ? 'var(--muted-foreground)' : 'var(--destructive)',
                          cursor: isMonad ? 'default' : 'pointer'
                        }}
                        title={removeLabel(participant.id, t)}
                        type="button"
                      >
                        <Minus size={14} />
                      </button>
                    </div>
                    {member && isExpanded ? (
                      <MemberSettings
                        member={member}
                        room={room}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
            {projectParticipants.length === 0 ? (
              <p style={{ margin: 0, fontFamily: sans, fontSize: 13, color: 'var(--muted-foreground)' }}>
                {t('web.workplace.noMembersHint')}
              </p>
            ) : null}
          </section>

          <section style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={sectionLabel}>{t('web.workplace.addMembers')}</div>
            <div
              style={{
                border: `1px solid ${'var(--border)'}`,
                borderRadius: boxR,
                background: 'var(--card)',
                display: 'flex',
                flexDirection: 'column'
              }}
            >
              {room.availableProjectMembers.length === 0 ? (
                <p style={{ margin: 0, padding: 12, fontFamily: sans, fontSize: 13, color: 'var(--muted-foreground)' }}>
                  {t('web.workplace.noAvailableMembers')}
                </p>
              ) : null}
              {room.availableProjectMembers.map((candidate, index) => (
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
                  <Avatar
                    av={candidate.name.slice(0, 2).toUpperCase()}
                    icon={candidate.icon}
                    kind="agent"
                    size={30}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <span
                        style={{
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontFamily: sans,
                          fontSize: 14,
                          fontWeight: 600
                        }}
                      >
                        {candidate.label}
                      </span>
                      <MiniTag tag={candidate.tag} />
                    </div>
                    <div style={{ marginTop: 2, fontFamily: mono, fontSize: 10, color: 'var(--muted-foreground)' }}>
                      {candidate.enabled ? t('web.workplace.available') : t('web.workplace.disabledInStudio')}
                    </div>
                  </div>
                  <button
                    className="workplace-action"
                    disabled={!candidate.enabled}
                    onClick={() => void room.addProjectMember(candidate.type, candidate.name)}
                    style={{
                      width: 28,
                      height: 28,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      border: `1px solid ${candidate.enabled ? 'var(--accent-blue)' : 'var(--border)'}`,
                      borderRadius: 8,
                      background: candidate.enabled ? 'var(--accent-blue-soft)' : 'var(--secondary)',
                      color: candidate.enabled ? 'var(--accent-blue)' : 'var(--muted-foreground)',
                      cursor: candidate.enabled ? 'pointer' : 'default'
                    }}
                    title={
                      candidate.enabled
                        ? t('web.workplace.addCandidate', { label: candidate.label })
                        : t('web.workplace.enableAgentFirst')
                    }
                    type="button"
                  >
                    <Plus size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
