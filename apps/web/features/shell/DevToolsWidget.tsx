'use client';

import type { ProjectId } from '@monad/protocol';

import {
  Activity01Icon,
  BugIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  RotateLeft01Icon,
  Wrench01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { useState } from 'react';

import { ProjectDebugConsole } from '@/features/workplace/debug/ProjectDebugConsole';
import { useWorkspaceShellStore } from '@/lib/workspace-shell-store';

interface DevToolLink {
  devOnly?: boolean;
  href: string;
  icon: IconSvgElement;
  label: string;
  port: string;
}

const tools: Array<Omit<DevToolLink, 'href' | 'port'> & { port: string | undefined }> = [
  {
    label: 'KV',
    port: process.env.NEXT_PUBLIC_MONAD_KV_UI_PORT,
    icon: DatabaseIcon,
    devOnly: true
  },
  {
    label: 'AI SDK',
    port: process.env.NEXT_PUBLIC_AI_SDK_DEVTOOLS_PORT,
    icon: Wrench01Icon,
    devOnly: true
  },
  {
    label: 'OTel',
    port: process.env.NEXT_PUBLIC_MONAD_OTEL_UI_PORT,
    icon: Activity01Icon
  }
];

const IMPECCABLE_STORAGE_KEYS = [
  'impeccable-live-session',
  'impeccable-live-session-handled',
  'impeccable-live-session-scroll',
  'impeccable-live-interaction',
  'impeccable-live-pick'
];

export function DevToolsWidget() {
  const activeProjectId = useWorkspaceShellStore((state) =>
    state.surface === 'workspace' ? state.activeProjectId : null
  );
  const [developerModeOpen, setDeveloperModeOpen] = useState(false);
  const links: DevToolLink[] = tools.flatMap((tool) =>
    tool.port && (process.env.NODE_ENV !== 'production' || !tool.devOnly)
      ? [
          {
            ...tool,
            href: `http://localhost:${tool.port}`,
            port: tool.port
          }
        ]
      : []
  );

  if (links.length === 0 && !activeProjectId) return null;

  const fixImpeccable = () => {
    for (const key of IMPECCABLE_STORAGE_KEYS) localStorage.removeItem(key);
    sessionStorage.clear();
    location.reload();
  };

  return (
    <>
      <div className="group glass-surface fixed right-4 bottom-4 z-50 flex items-center gap-1 overflow-hidden p-1 text-popover-foreground">
        <div
          aria-hidden="true"
          className="flex h-9 items-center gap-2 rounded-sm px-3 font-medium text-muted-foreground text-xs"
        >
          <HugeiconsIcon
            className="size-4"
            icon={Wrench01Icon}
          />
          <span>Dev</span>
        </div>
        <div className="flex max-w-0 translate-x-1 items-center gap-1 overflow-hidden opacity-0 transition-[max-width,opacity,transform] duration-200 ease-out group-focus-within:max-w-[720px] group-focus-within:translate-x-0 group-focus-within:opacity-100 group-hover:max-w-[720px] group-hover:translate-x-0 group-hover:opacity-100 motion-reduce:translate-x-0 motion-reduce:transition-none">
          {activeProjectId ? (
            <button
              aria-label="Open project developer trace"
              aria-pressed={developerModeOpen}
              className="inline-flex h-9 items-center gap-2 rounded-sm px-3 font-medium text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setDeveloperModeOpen(true)}
              title="Open project developer trace"
              type="button"
            >
              <HugeiconsIcon
                aria-hidden="true"
                className="size-4"
                icon={BugIcon}
              />
              <span>Developer Mode</span>
            </button>
          ) : null}
          <button
            aria-label="Fix Impeccable live state"
            className="inline-flex h-9 items-center gap-2 rounded-sm px-3 font-medium text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={fixImpeccable}
            title="Clear Impeccable live state and reload"
            type="button"
          >
            <HugeiconsIcon
              aria-hidden="true"
              className="size-4"
              icon={RotateLeft01Icon}
            />
            <span>Fix Impeccable</span>
          </button>
          {links.map(({ href, icon: Icon, label, port }) => (
            <a
              aria-label={`Open ${label} on port ${port}`}
              className="inline-flex h-9 items-center gap-2 rounded-sm px-3 font-medium text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={href}
              key={label}
              rel="noreferrer"
              target="_blank"
              title={`Open ${label} (${port})`}
            >
              <HugeiconsIcon
                aria-hidden="true"
                className="size-4"
                icon={Icon}
              />
              <span>{label}</span>
              <HugeiconsIcon
                aria-hidden="true"
                className="size-3.5 opacity-65"
                icon={ExternalLinkIcon}
              />
            </a>
          ))}
        </div>
      </div>
      {developerModeOpen ? (
        <ProjectDebugConsole
          onClose={() => setDeveloperModeOpen(false)}
          projectId={activeProjectId as ProjectId | null}
        />
      ) : null}
    </>
  );
}
