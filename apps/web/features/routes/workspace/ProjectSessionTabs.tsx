'use client';

import type { ProjectId, Session, SessionId } from '@monad/protocol';

import { Cancel01Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useCreateProjectSessionMutation } from '@monad/client-rtk';

interface ProjectSessionTabsProps {
  projectId: ProjectId;
  sessions: Session[];
  activeSessionId: SessionId | null;
  onSwitchSession: (id: SessionId) => void;
  onCloseSession: (id: SessionId) => Promise<void>;
}

export function ProjectSessionTabs({
  projectId,
  sessions,
  activeSessionId,
  onSwitchSession,
  onCloseSession
}: ProjectSessionTabsProps): React.ReactElement {
  const [createProjectSession, createState] = useCreateProjectSessionMutation();

  return (
    <>
      <style>{`
        .project-session-tabs {
          display: flex;
          align-items: center;
          gap: 4px;
          min-width: 0;
          max-width: 42vw;
          overflow-x: auto;
          scrollbar-width: none;
        }
        .project-session-tabs::-webkit-scrollbar { display: none; }
        .project-session-tab {
          display: inline-flex;
          align-items: center;
          flex: none;
          height: 26px;
          padding: 0 4px 0 10px;
          border: 1px solid transparent;
          border-radius: 7px;
          color: rgb(var(--textColor-secondary));
          background: transparent;
        }
        .project-session-tab[data-active='true'] {
          border-color: rgb(var(--borderColor-secondary) / .16);
          background: rgb(var(--backgroundColor-state-enabled) / .42);
          color: rgb(var(--textColor-primary));
        }
        .project-session-tab:hover {
          background: rgb(var(--backgroundColor-state-hover) / .18);
        }
        .project-session-tab-trigger {
          max-width: 140px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
          font-weight: 500;
        }
        .project-session-tab-close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          margin-left: 4px;
          border-radius: 5px;
          color: rgb(var(--textColor-secondary) / .72);
          flex: none;
        }
        .project-session-tab-close:hover {
          background: rgb(var(--backgroundColor-state-hover) / .28);
          color: rgb(var(--textColor-primary));
        }
        .project-session-tab-add {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          flex: none;
          border-radius: 7px;
          color: rgb(var(--textColor-secondary));
        }
        .project-session-tab-add:hover {
          background: rgb(var(--backgroundColor-state-hover) / .18);
          color: rgb(var(--textColor-primary));
        }
        .project-session-tab-add:disabled {
          opacity: .5;
          pointer-events: none;
        }
      `}</style>
      <div
        className="project-session-tabs"
        role="tablist"
      >
        {sessions.map((session) => (
          <div
            className="project-session-tab"
            data-active={session.id === activeSessionId ? 'true' : undefined}
            key={session.id}
          >
            <button
              aria-selected={session.id === activeSessionId}
              className="project-session-tab-trigger"
              onClick={() => onSwitchSession(session.id as SessionId)}
              role="tab"
              title={session.title}
              type="button"
            >
              {session.title}
            </button>
            <button
              aria-label={`Close ${session.title}`}
              className="project-session-tab-close"
              onClick={(event) => {
                event.stopPropagation();
                void onCloseSession(session.id as SessionId);
              }}
              title="Close session"
              type="button"
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                size={11}
              />
            </button>
          </div>
        ))}
        <button
          aria-label="New session"
          className="project-session-tab-add"
          disabled={createState.isLoading}
          onClick={() => void createProjectSession({ projectId, title: 'New session' })}
          title="New session"
          type="button"
        >
          <HugeiconsIcon
            icon={PlusSignIcon}
            size={14}
          />
        </button>
      </div>
    </>
  );
}
