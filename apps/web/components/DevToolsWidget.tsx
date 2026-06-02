'use client';

import type { LucideIcon } from 'lucide-react';

import { Activity, Database, ExternalLink, RotateCcw, Wrench } from 'lucide-react';

interface DevToolLink {
  devOnly?: boolean;
  href: string;
  icon: LucideIcon;
  label: string;
  port: string;
}

const tools: Array<Omit<DevToolLink, 'href' | 'port'> & { port: string | undefined }> = [
  {
    label: 'KV',
    port: process.env.NEXT_PUBLIC_MONAD_KV_UI_PORT,
    icon: Database,
    devOnly: true
  },
  {
    label: 'AI SDK',
    port: process.env.NEXT_PUBLIC_AI_SDK_DEVTOOLS_PORT,
    icon: Wrench,
    devOnly: true
  },
  {
    label: 'OTel',
    port: process.env.NEXT_PUBLIC_MONAD_OTEL_UI_PORT,
    icon: Activity
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

  if (links.length === 0) return null;

  const fixImpeccable = () => {
    for (const key of IMPECCABLE_STORAGE_KEYS) localStorage.removeItem(key);
    sessionStorage.clear();
    location.reload();
  };

  return (
    <div className="glass-surface fixed right-4 bottom-4 z-50 flex items-center gap-1 p-1 text-popover-foreground">
      <button
        aria-label="Fix Impeccable live state"
        className="inline-flex h-9 items-center gap-2 rounded-sm px-3 font-medium text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={fixImpeccable}
        title="Clear Impeccable live state and reload"
        type="button"
      >
        <RotateCcw
          aria-hidden="true"
          className="size-4"
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
          <Icon
            aria-hidden="true"
            className="size-4"
          />
          <span>{label}</span>
          <ExternalLink
            aria-hidden="true"
            className="size-3.5 opacity-65"
          />
        </a>
      ))}
    </div>
  );
}
