'use client';

import type { SessionId } from '@monad/protocol';

import { Bug, ChevronDown, MessageSquare, Network, Settings } from 'lucide-react';
import { useState } from 'react';

import { ProjectDebugConsole } from '@/components/workplace/ProjectDebugConsole';

interface ProjectTopBarProps {
  mode: 'graph' | 'chat';
  projectName: string;
  sessionId: SessionId | null;
  status: string;
  onModeChange: (mode: 'graph' | 'chat') => void;
  onOpenSettings: () => void;
}

const modeIcon = {
  chat: MessageSquare,
  graph: Network
};

// The developer trace console captures message text / request bodies — dev-only. Gated on
// NODE_ENV so the button and console never render in release builds.
const DEV_TRACE = process.env.NODE_ENV !== 'production';

export function ProjectTopBar({
  mode,
  projectName,
  sessionId,
  status,
  onModeChange,
  onOpenSettings
}: ProjectTopBarProps) {
  const ModeIcon = modeIcon[mode];
  const [developerModeOpen, setDeveloperModeOpen] = useState(false);

  return (
    <>
      <style>{`
        .project-topbar {
          flex-shrink: 0;
          height: 44px;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 0 14px;
          border-bottom: 1px solid rgb(var(--borderColor-secondary) / .12);
          background: rgb(var(--backgroundColor-surface-container) / .78);
          color: rgb(var(--textColor-primary));
          z-index: 20;
        }
        .project-topbar-main {
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .project-topbar-kicker {
          font-family: var(--font-mono, ui-monospace, monospace);
          font-size: 10px;
          font-weight: 600;
          color: rgb(var(--textColor-secondary) / .68);
          text-transform: uppercase;
        }
        .project-topbar-name {
          min-width: 0;
          max-width: 32vw;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 13px;
          font-weight: 500;
        }
        .project-topbar-status {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 22px;
          padding: 0 8px;
          border: 1px solid rgb(var(--borderColor-secondary) / .12);
          border-radius: 999px;
          background: rgb(var(--backgroundColor-state-enabled) / .38);
          color: rgb(var(--textColor-secondary));
          font-size: 11px;
        }
        .project-topbar-dot {
          width: 6px;
          height: 6px;
          border-radius: 999px;
          background: rgb(34 197 94);
          box-shadow: 0 0 8px rgb(34 197 94 / .5);
        }
        .project-topbar-spacer { flex: 1; }
        .project-topbar-view {
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          height: 28px;
          min-width: 142px;
          padding: 0 30px 0 10px;
          border: 1px solid rgb(var(--borderColor-secondary) / .16);
          border-radius: 8px;
          background: rgb(var(--backgroundColor-state-enabled) / .42);
          color: rgb(var(--textColor-primary));
        }
        .project-topbar-view svg {
          flex-shrink: 0;
          color: rgb(var(--textColor-secondary));
        }
        .project-topbar-select {
          position: absolute;
          inset: 0;
          width: 100%;
          opacity: 0;
          cursor: pointer;
        }
        .project-topbar-view-label {
          font-size: 12px;
          font-weight: 500;
        }
        .project-topbar-chevron {
          position: absolute;
          right: 9px;
          pointer-events: none;
        }
        .project-topbar-debug,
        .project-topbar-settings {
          width: 28px;
          height: 28px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid rgb(var(--borderColor-secondary) / .16);
          border-radius: 8px;
          background: rgb(var(--backgroundColor-state-enabled) / .28);
          color: rgb(var(--textColor-secondary));
          cursor: pointer;
        }
        .project-topbar-debug {
          width: auto;
          gap: 7px;
          padding: 0 10px;
          font-size: 12px;
          font-weight: 500;
        }
        .project-topbar-settings:hover,
        .project-topbar-debug:hover,
        .project-topbar-view:hover {
          background: rgb(var(--backgroundColor-state-hover) / .18);
          color: rgb(var(--textColor-primary));
        }
      `}</style>
      <div className="project-topbar">
        <div className="project-topbar-main">
          <span className="project-topbar-kicker">Project</span>
          <span className="project-topbar-name">{projectName}</span>
          <span className="project-topbar-status">
            <span className="project-topbar-dot" />
            {status}
          </span>
        </div>
        <div className="project-topbar-spacer" />
        <label className="project-topbar-view">
          <ModeIcon size={14} />
          <span className="project-topbar-view-label">{mode === 'graph' ? 'Graph view' : 'Chat room'}</span>
          <ChevronDown
            className="project-topbar-chevron"
            size={14}
          />
          <select
            aria-label="Project view mode"
            className="project-topbar-select"
            onChange={(event) => onModeChange(event.target.value as 'graph' | 'chat')}
            value={mode}
          >
            <option value="graph">Graph view</option>
            <option value="chat">Chat room</option>
          </select>
        </label>
        {DEV_TRACE && (
          <button
            aria-pressed={developerModeOpen}
            className="project-topbar-debug"
            onClick={() => setDeveloperModeOpen(true)}
            title="Open project developer trace"
            type="button"
          >
            <Bug size={14} />
            Developer Mode
          </button>
        )}
        <button
          aria-label="Open project settings"
          className="project-topbar-settings"
          onClick={onOpenSettings}
          title="Project settings"
          type="button"
        >
          <Settings size={14} />
        </button>
      </div>
      {DEV_TRACE && developerModeOpen ? (
        <ProjectDebugConsole
          onClose={() => setDeveloperModeOpen(false)}
          sessionId={sessionId}
        />
      ) : null}
    </>
  );
}
