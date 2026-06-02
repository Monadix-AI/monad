'use client';

import type { CSSProperties } from 'react';

import { useMemo } from 'react';

import { useT } from '@/components/I18nProvider';
import { AgentTasksRail } from './AgentTasksRail';
import { Composer } from './Composer';
import { ProjectHeader } from './ProjectHeader';
import { ProjectRail } from './ProjectRail';
import { ProjectSettings } from './ProjectSettings';
import { getPreset } from './presets/registry';
import { toCanvas } from './presets/to-canvas';
import { boxR, mono, sans } from './styles';
import { useProject } from './use-project';

export function Workplace({
  projectId,
  embedded = false,
  mode = 'chat',
  projectSettingsOpen = false,
  onProjectSettingsOpenChange
}: {
  projectId: string;
  embedded?: boolean;
  mode?: string;
  projectSettingsOpen?: boolean;
  onProjectSettingsOpenChange?: (open: boolean) => void;
}): React.ReactElement {
  const project = useProject(projectId);
  const t = useT();
  // The body renders the active preset (chat / graph / future atom views); the management chrome
  // (header, composer, rails) is identical across presets and host-rendered below.
  const PresetView = getPreset(mode).render;
  // Rebuild the canvas only when the project view-model changes, not on every unrelated re-render
  // (settings open/close, locale) — keeps the transcript subtree from reconciling needlessly.
  const canvas = useMemo(() => toCanvas(project), [project]);

  return (
    <div
      style={
        {
          minHeight: embedded ? '100%' : '100vh',
          height: embedded ? '100%' : undefined,
          flex: embedded ? 1 : undefined,
          minWidth: embedded ? 0 : undefined,
          background: embedded ? 'transparent' : 'var(--background)',
          padding: embedded ? 0 : '18px 24px 32px',
          boxSizing: 'border-box',
          overflow: embedded ? 'hidden' : undefined,
          display: 'flex',
          flexDirection: 'column',
          fontFamily: sans,
          color: 'var(--foreground)',
          WebkitFontSmoothing: 'antialiased'
        } as CSSProperties
      }
    >
      {!embedded ? (
        <div
          style={{
            maxWidth: 1360,
            margin: '0 auto 12px',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 24,
            flexWrap: 'wrap'
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 1.2,
                textTransform: 'uppercase',
                fontFamily: mono,
                color: 'var(--muted-foreground)'
              }}
            >
              Workplace
            </div>
            <div style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.15, marginTop: 4 }}>
              Agent project <span style={{ color: 'var(--muted-foreground)', fontWeight: 400 }}>workplace</span>
            </div>
          </div>
          <a
            href="/"
            style={{
              fontFamily: mono,
              fontSize: 11,
              color: 'var(--muted-foreground)',
              textDecoration: 'none',
              border: `1px solid ${'var(--border)'}`,
              borderRadius: 8,
              padding: '6px 12px',
              background: 'var(--card)',
              whiteSpace: 'nowrap'
            }}
          >
            ← back to workspace
          </a>
        </div>
      ) : null}

      <div
        style={{
          maxWidth: embedded ? '100%' : 1360,
          margin: embedded ? 0 : '0 auto',
          border: embedded ? 0 : `1px solid ${'var(--border)'}`,
          borderRadius: embedded ? 0 : boxR,
          background: 'var(--card)',
          overflow: 'hidden',
          boxShadow: embedded ? 'none' : 'var(--shadow-lg)',
          height: '100%',
          minHeight: 0,
          position: 'relative'
        }}
      >
        <div
          className="workplace-layout"
          style={{
            height: embedded ? '100%' : 'min(780px, calc(100vh - 102px))',
            minHeight: embedded ? undefined : 620,
            display: 'flex',
            background: 'var(--card)',
            position: 'relative',
            overflow: 'hidden'
          }}
        >
          {!embedded ? <ProjectRail project={project} /> : null}

          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <ProjectHeader
              embedded={embedded}
              project={project}
            />
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <PresetView
                canvas={canvas}
                embedded={embedded}
                t={t}
              />
            </div>
            <Composer room={project} />
          </div>

          <AgentTasksRail room={project} />
        </div>
        {projectSettingsOpen ? (
          <ProjectSettings
            onClose={() => onProjectSettingsOpenChange?.(false)}
            room={project}
          />
        ) : null}
      </div>
    </div>
  );
}
