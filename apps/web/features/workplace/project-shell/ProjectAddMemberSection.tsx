import type { ProjectController } from '../use-project';

import { PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { useT } from '@/components/I18nProvider';
import { AgentIdentity, AgentInstanceAvatar } from '../Bits';
import { boxR, mono, sans, sectionLabel } from '../styles';

type AvailableProjectMember = ProjectController['availableProjectMembers'][number];

function CandidateRow({
  actionLabel,
  candidate,
  index,
  onAdd
}: {
  actionLabel: string | null;
  candidate: AvailableProjectMember;
  index: number;
  onAdd: () => void;
}): React.ReactElement {
  const t = useT();
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '32px minmax(0, 1fr) auto',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        borderTop: index === 0 ? 'none' : `1px solid ${'var(--border)'}`
      }}
    >
      <AgentInstanceAvatar
        agent={{ ...candidate, name: candidate.label }}
        bare
        size={30}
      />
      <div style={{ minWidth: 0 }}>
        <AgentIdentity
          name={candidate.label}
          nameStyle={{ fontFamily: sans, fontSize: 14, fontWeight: 600 }}
        />
      </div>
      <button
        className="workplace-action"
        disabled={!candidate.enabled}
        onClick={onAdd}
        style={{
          minHeight: 28,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          border: `1px solid ${candidate.enabled ? 'var(--accent-blue)' : 'var(--border)'}`,
          borderRadius: 8,
          background: candidate.enabled ? 'var(--accent-blue-soft)' : 'var(--secondary)',
          color: candidate.enabled ? 'var(--accent-blue)' : 'var(--muted-foreground)',
          fontFamily: mono,
          fontSize: 11,
          padding: '5px 9px',
          whiteSpace: 'nowrap'
        }}
        title={
          candidate.enabled
            ? (actionLabel ?? t('web.workplace.addCandidate', { label: candidate.label }))
            : t('web.workplace.enableAgentFirst')
        }
        type="button"
      >
        <HugeiconsIcon
          icon={PlusSignIcon}
          size={14}
        />
        {actionLabel}
      </button>
    </div>
  );
}

export function ProjectAddMemberSection({
  candidates,
  onAdd,
  promoted = false,
  title
}: {
  candidates: AvailableProjectMember[];
  onAdd: (candidate: AvailableProjectMember) => void;
  promoted?: boolean;
  title: string;
}): React.ReactElement {
  const t = useT();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ ...sectionLabel, color: 'var(--muted-foreground)' }}>{title}</div>
      <div
        style={{
          border: `1px solid ${promoted ? 'color-mix(in srgb, var(--accent-blue) 48%, var(--border))' : 'var(--border)'}`,
          borderRadius: boxR,
          background: promoted ? 'color-mix(in srgb, var(--accent-blue) 5%, var(--card))' : 'var(--card)',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {candidates.length === 0 ? (
          <p style={{ margin: 0, padding: 12, fontFamily: sans, fontSize: 13, color: 'var(--muted-foreground)' }}>
            {t('web.workplace.noAvailableMembers')}
          </p>
        ) : null}
        {candidates.map((candidate, index) => (
          <CandidateRow
            actionLabel={candidate.type === 'native-cli' ? t('web.workplace.spawnAgentMember') : null}
            candidate={candidate}
            index={index}
            key={candidate.id}
            onAdd={() => onAdd(candidate)}
          />
        ))}
      </div>
    </div>
  );
}
