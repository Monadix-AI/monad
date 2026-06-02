import type { ProjectController } from './use-project';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@monad/ui';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { ghostButtonStyle } from './Bits';
import { mono } from './styles';

const NO_MODERATOR = '__none__';

/** Shared working folder for the project — set it once and every agent (moderator + delegated
 *  subagents) resolves fs/shell paths against it. Empty input clears it back to the default workspace. */
function WorkdirControl({ workdir }: { workdir: ProjectController['workdir'] }): React.ReactElement {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const commit = async (value: string) => {
    setBusy(true);
    try {
      await workdir.set(value.trim());
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <input
        className="h-8 rounded-full font-mono text-[11px]"
        disabled={busy}
        onBlur={() => setEditing(false)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit(draft);
          if (e.key === 'Escape') setEditing(false);
        }}
        placeholder={t('web.workplace.workdirInputPlaceholder')}
        ref={(el) => el?.focus()}
        style={{
          width: 240,
          border: `1px solid ${'var(--accent-blue)'}`,
          background: 'var(--card)',
          color: 'var(--foreground)',
          borderRadius: 999,
          padding: '0 12px'
        }}
        value={draft}
      />
    );
  }

  return (
    <button
      className="workplace-action"
      onClick={() => {
        setDraft(workdir.path ?? '');
        setEditing(true);
      }}
      style={{
        fontFamily: mono,
        fontSize: 11,
        color: 'var(--foreground)',
        border: `1px solid ${'var(--border)'}`,
        background: 'var(--card)',
        borderRadius: 999,
        padding: '6px 10px',
        cursor: 'pointer',
        maxWidth: 280,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
      title={workdir.path ?? t('web.workplace.setFolderHint')}
      type="button"
    >
      📁 {workdir.path ?? t('web.workplace.setFolder')}
    </button>
  );
}

export function ProjectHeader({
  project: room
}: {
  project: ProjectController;
  embedded?: boolean;
}): React.ReactElement {
  const t = useT();
  const activeProject = room.projects.find((p) => p.active);
  const moderatorAgentId = room.moderator.moderatorAgentId ?? '';
  const moderatorOptions = room.moderator.agents.map((agent) => ({
    id: String(agent.id),
    label: String(agent.name || agent.id)
  }));
  const moderatorMissing =
    moderatorAgentId && !moderatorOptions.some((agent) => agent.id === moderatorAgentId) ? moderatorAgentId : null;
  const hasModeratorCandidates = room.moderator.agents.length > 0;
  return (
    <div
      style={{
        minHeight: 68,
        flex: 'none',
        borderBottom: `1px solid ${'var(--border)'}`,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-end',
        padding: '12px 16px 10px',
        gap: '9px 18px',
        background: 'var(--card)'
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: '0 1 auto', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          <span style={{ fontSize: 18, fontWeight: 600, whiteSpace: 'nowrap', lineHeight: 1.2 }}>
            # {activeProject?.name ?? room.projectId}
          </span>
        </div>
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <WorkdirControl workdir={room.workdir} />
        <div style={{ width: 190 }}>
          <Select
            disabled={!hasModeratorCandidates}
            onValueChange={(value) =>
              void room.moderator.setModeratorAgentId(value === NO_MODERATOR ? undefined : value)
            }
            value={moderatorAgentId || NO_MODERATOR}
          >
            <SelectTrigger
              className="h-8 rounded-full font-mono text-[11px]"
              title={hasModeratorCandidates ? t('web.ch.moderatorAgent') : t('web.workplace.createAgentFirst')}
            >
              <SelectValue placeholder={t('web.ch.moderatorAgentPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_MODERATOR}>{t('web.ch.noModeratorAgent')}</SelectItem>
              {moderatorMissing ? (
                <SelectItem value={moderatorMissing}>
                  {t('web.ch.missingModeratorAgent', { id: moderatorMissing })}
                </SelectItem>
              ) : null}
              {moderatorOptions.map((agent) => (
                <SelectItem
                  key={agent.id}
                  value={agent.id}
                >
                  {agent.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <span
          style={{
            fontFamily: mono,
            fontSize: 11,
            color: 'var(--foreground)',
            border: `1px solid ${'var(--border)'}`,
            background: 'var(--card)',
            borderRadius: 999,
            padding: '6px 10px',
            whiteSpace: 'nowrap'
          }}
        >
          {t('web.workplace.agentCount', { count: room.railAgents.length })}
        </span>
        <button
          className="workplace-action"
          onClick={() => room.preset.set('chat')}
          style={{
            fontFamily: mono,
            fontSize: 11,
            color: 'var(--foreground)',
            border: `1px solid ${room.approvals.length > 0 ? 'var(--accent-blue)' : 'var(--border)'}`,
            background:
              room.approvals.length > 0 ? 'color-mix(in srgb, var(--accent-blue) 16%, transparent)' : 'var(--card)',
            borderRadius: 999,
            padding: '6px 10px',
            cursor: 'pointer',
            whiteSpace: 'nowrap'
          }}
          type="button"
        >
          ⚠{' '}
          {room.approvals.length === 0
            ? t('web.workplace.noApprovals')
            : t('web.workplace.approvalsToReview', { count: room.approvals.length })}
        </button>
        <button
          className="workplace-action"
          onClick={room.pauseAll}
          style={ghostButtonStyle({
            height: 34,
            padding: '0 13px',
            fontSize: 13,
            whiteSpace: 'nowrap',
            borderRadius: 999,
            background: room.paused ? 'color-mix(in srgb, var(--accent-blue) 16%, transparent)' : 'var(--card)'
          })}
          type="button"
        >
          {room.paused ? `▶ ${t('web.workplace.resumeAll')}` : `⏸ ${t('web.workplace.pauseAll')}`}
        </button>
      </div>
    </div>
  );
}
