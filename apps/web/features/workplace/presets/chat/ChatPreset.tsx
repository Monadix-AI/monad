import type { ProjectTabKey } from '../../types';
import type { PresetDefinition, ProjectView } from '../types';

import { useState } from 'react';

import { ActivityLog } from '../../activity/ActivityLog';
import { ChatTranscript } from '../../activity/ChatTranscript';
import { mono, sans } from '../../styles';
import { PROJECT_TABS } from '../../types';

// The default preset: today's conversation rendering. The chat/activity tab is the preset's own
// concern (other presets don't have it), so it lives here as local state, not on the host.
function ChatPresetView({ canvas }: ProjectView): React.ReactElement {
  const [tab, setTab] = useState<ProjectTabKey>('chat');

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 16px 0'
        }}
      >
        {PROJECT_TABS.map((projectTab) => {
          const active = tab === projectTab.key;
          return (
            <button
              className="workplace-action"
              key={projectTab.key}
              onClick={() => setTab(projectTab.key)}
              style={{
                background: active ? 'var(--accent-blue-soft)' : 'var(--card)',
                border: active ? `1px solid ${'var(--accent-blue)'}` : `1px solid ${'var(--border)'}`,
                borderRadius: 999,
                padding: '5px 11px',
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                cursor: 'pointer',
                fontFamily: sans,
                fontSize: 14,
                fontWeight: active ? 600 : 500,
                color: active ? 'var(--accent-blue)' : 'var(--muted-foreground)',
                whiteSpace: 'nowrap'
              }}
              type="button"
            >
              {projectTab.label}
              {projectTab.badge ? (
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: 10,
                    color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
                    border: `1px solid ${'var(--border)'}`,
                    background: active ? 'var(--card)' : 'transparent',
                    borderRadius: 9,
                    padding: '0 6px'
                  }}
                >
                  {projectTab.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'chat' ? <ChatTranscript room={canvas} /> : <ActivityLog room={canvas} />}
      </div>
    </div>
  );
}

export const chatPreset: PresetDefinition = {
  id: 'chat',
  labelKey: 'web.workplace.preset.chat',
  icon: 'message-square',
  source: 'builtin',
  render: ChatPresetView
};
