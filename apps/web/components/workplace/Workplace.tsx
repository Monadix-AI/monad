'use client';

import type { CSSProperties } from 'react';
import type { ProjectExperienceDefinition } from './experiences/types';

import { useCallback, useMemo, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { getProjectExperience } from './experiences/registry';
import { toExperienceRuntime } from './experiences/to-runtime';
import { NativeCliStreamModal } from './NativeCliStreamModal';
import { ProjectRail } from './ProjectRail';
import { ProjectSettings } from './ProjectSettings';
import { boxR, mono, sans } from './styles';
import { useProject } from './use-project';

export function Workplace({
  projectId,
  embedded = false,
  mode = 'chat',
  experiences,
  projectSettingsOpen = false,
  onModeChange,
  onProjectSettingsOpenChange
}: {
  projectId: string;
  embedded?: boolean;
  mode?: string;
  experiences?: ProjectExperienceDefinition[];
  projectSettingsOpen?: boolean;
  onModeChange?: (mode: string) => void;
  onProjectSettingsOpenChange?: (open: boolean) => void;
}): React.ReactElement {
  const project = useProject(projectId);
  const t = useT();
  const [internalProjectSettingsOpen, setInternalProjectSettingsOpen] = useState(false);
  const [selectedProjectMemberId, setSelectedProjectMemberId] = useState<string | null>(null);
  const [followedNativeCliSessionId, setFollowedNativeCliSessionId] = useState<string | null>(null);
  const settingsOpen = projectSettingsOpen || internalProjectSettingsOpen;
  const closeProjectSettings = useCallback(() => {
    setInternalProjectSettingsOpen(false);
    setSelectedProjectMemberId(null);
    onProjectSettingsOpenChange?.(false);
  }, [onProjectSettingsOpenChange]);
  const openAgentCard = useCallback(
    (memberId: string) => {
      setSelectedProjectMemberId(memberId);
      setInternalProjectSettingsOpen(true);
      onProjectSettingsOpenChange?.(true);
    },
    [onProjectSettingsOpenChange]
  );
  const followNativeCliSession = useCallback((id: string) => {
    setFollowedNativeCliSessionId(id);
  }, []);
  const followedNativeCliStream = useMemo(
    () => project.nativeCliStreams.find((stream) => stream.id === followedNativeCliSessionId),
    [project.nativeCliStreams, followedNativeCliSessionId]
  );
  const experience = getProjectExperience(mode, experiences);
  const runtime = useMemo(
    () =>
      toExperienceRuntime(project, {
        followNativeCliSession,
        openAgentCard,
        switchExperience: onModeChange ?? (() => {})
      }),
    [project, followNativeCliSession, onModeChange, openAgentCard]
  );

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

          {experience.render({
            embedded,
            onProjectSettingsOpenChange,
            project,
            projectSettingsOpen: settingsOpen,
            runtime,
            t
          })}
        </div>
        {settingsOpen ? (
          <ProjectSettings
            initialMemberId={selectedProjectMemberId}
            onClose={closeProjectSettings}
            room={project}
          />
        ) : null}
        {followedNativeCliStream ? (
          <NativeCliStreamModal
            onClose={() => setFollowedNativeCliSessionId(null)}
            onStop={(id) => void project.stopNativeCli(id)}
            stream={followedNativeCliStream}
          />
        ) : null}
      </div>
    </div>
  );
}
