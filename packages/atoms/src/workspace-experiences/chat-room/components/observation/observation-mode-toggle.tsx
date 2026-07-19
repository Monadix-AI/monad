import type { CSSProperties } from 'react';
import type { ObservationMode } from './panel-state.ts';
import type { RawDisplayMode } from './raw-view.ts';

import { workspaceSans as sans } from '@monad/ui/components/AgentAvatar';

const OPTIONS: { mode: ObservationMode; label: string }[] = [
  { mode: 'convenience', label: 'Activity' },
  { mode: 'raw', label: 'Raw' }
];

// Segmented control switching the observation data plane. Convenience is the neutral projected timeline;
// raw is the verbatim provider-frame diagnostic view.
export function ObservationModeToggle({
  mode,
  onSelect
}: {
  mode: ObservationMode;
  onSelect: (mode: ObservationMode) => void;
}): React.ReactElement {
  return (
    <div
      aria-label="Observation view"
      role="tablist"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 999,
        background: 'var(--secondary)',
        display: 'inline-flex',
        flex: 'none',
        gap: 2,
        padding: 2
      }}
    >
      {OPTIONS.map((option) => {
        const active = option.mode === mode;
        return (
          <button
            aria-selected={active}
            className="workplace-action"
            key={option.mode}
            onClick={() => onSelect(option.mode)}
            role="tab"
            style={optionStyle(active)}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function RawDisplayModeToggle({
  mode,
  onSelect
}: {
  mode: RawDisplayMode;
  onSelect: (mode: RawDisplayMode) => void;
}): React.ReactElement {
  return (
    <div
      aria-label="Raw display"
      role="tablist"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 999,
        background: 'var(--secondary)',
        display: 'inline-flex',
        flex: 'none',
        gap: 2,
        padding: 2
      }}
    >
      {(['lines', 'parsed'] as const).map((option) => (
        <button
          aria-selected={option === mode}
          className="workplace-action"
          key={option}
          onClick={() => onSelect(option)}
          role="tab"
          style={optionStyle(option === mode)}
          type="button"
        >
          {option === 'lines' ? 'Lines' : 'Parsed'}
        </button>
      ))}
    </div>
  );
}

function optionStyle(active: boolean): CSSProperties {
  return {
    border: 0,
    borderRadius: 999,
    background: active ? 'color-mix(in srgb, var(--primary) 16%, var(--background))' : 'transparent',
    color: active ? 'var(--primary)' : 'var(--muted-foreground)',
    fontFamily: sans,
    fontSize: 11,
    fontWeight: 650,
    lineHeight: 1,
    minHeight: 24,
    padding: '0 8px'
  };
}
