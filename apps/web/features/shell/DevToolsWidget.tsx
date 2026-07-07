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
import { cn } from '@monad/ui';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';

import { ProjectDebugConsole } from '@/features/workplace/debug/ProjectDebugConsole';
import { useWorkspaceShellStore } from '@/lib/workspace-shell-store';

interface DevToolLink {
  devOnly?: boolean;
  href: string;
  icon: IconSvgElement;
  label: string;
  port: string;
}

type DevToolActionKind = 'developer-mode' | 'fix-impeccable' | 'link';

export interface DevToolAction {
  devOnly?: boolean;
  href?: string;
  icon: IconSvgElement;
  kind: DevToolActionKind;
  label: string;
  port?: string;
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

export function buildDevToolActions({
  activeProjectId,
  ports,
  production = process.env.NODE_ENV === 'production'
}: {
  activeProjectId: ProjectId | string | null;
  ports: {
    aiSdk?: string;
    kv?: string;
    otel?: string;
  };
  production?: boolean;
}): DevToolAction[] {
  const links: DevToolLink[] = tools.flatMap((tool) => {
    const port = tool.label === 'KV' ? ports.kv : tool.label === 'AI SDK' ? ports.aiSdk : ports.otel;
    return port && (!production || !tool.devOnly)
      ? [
          {
            ...tool,
            href: `http://localhost:${port}`,
            port
          }
        ]
      : [];
  });

  return [
    ...(activeProjectId
      ? [
          {
            kind: 'developer-mode' as const,
            label: 'Developer Mode',
            icon: BugIcon
          }
        ]
      : []),
    {
      kind: 'fix-impeccable' as const,
      label: 'Fix Impeccable',
      icon: RotateLeft01Icon
    },
    ...links.map(({ devOnly, href, icon, label, port }) => ({
      devOnly,
      href,
      icon,
      kind: 'link' as const,
      label,
      port
    }))
  ];
}

export function DevToolsWidget() {
  const activeProjectId = useWorkspaceShellStore((state) =>
    state.surface === 'workspace' ? state.activeProjectId : null
  );
  const prefersReducedMotion = useReducedMotion();
  const [developerModeOpen, setDeveloperModeOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const actions = useMemo(
    () =>
      buildDevToolActions({
        activeProjectId,
        ports: {
          kv: process.env.NEXT_PUBLIC_MONAD_KV_UI_PORT,
          aiSdk: process.env.NEXT_PUBLIC_AI_SDK_DEVTOOLS_PORT,
          otel: process.env.NEXT_PUBLIC_MONAD_OTEL_UI_PORT
        }
      }),
    [activeProjectId]
  );

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  if (actions.length === 0) return null;

  const fixImpeccable = () => {
    for (const key of IMPECCABLE_STORAGE_KEYS) localStorage.removeItem(key);
    sessionStorage.clear();
    location.reload();
  };

  return (
    <>
      <div className="fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2 text-popover-foreground">
        <AnimatePresence>
          {open ? (
            <motion.div
              animate="open"
              className="flex flex-col items-end gap-2"
              exit="closed"
              initial="closed"
              variants={{
                closed: { transition: { staggerChildren: 0.025, staggerDirection: -1 } },
                open: { transition: { delayChildren: 0.03, staggerChildren: 0.045 } }
              }}
            >
              {actions.map((action) => {
                const Icon = action.icon;
                const commonClassName =
                  'glass-surface group flex h-10 items-center gap-2 rounded-full p-1 pr-3 text-xs shadow-lg outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring';
                const content = (
                  <>
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-background/75 text-foreground">
                      <HugeiconsIcon
                        aria-hidden="true"
                        className="size-4"
                        icon={Icon}
                      />
                    </span>
                    <span className="whitespace-nowrap font-medium">{action.label}</span>
                    {action.kind === 'link' ? (
                      <HugeiconsIcon
                        aria-hidden="true"
                        className="size-3.5 opacity-65"
                        icon={ExternalLinkIcon}
                      />
                    ) : null}
                  </>
                );

                return (
                  <motion.div
                    key={action.label}
                    transition={
                      prefersReducedMotion ? { duration: 0 } : { type: 'spring', bounce: 0.2, duration: 0.34 }
                    }
                    variants={{
                      closed: { opacity: 0, scale: 0.72, y: 16 },
                      open: { opacity: 1, scale: 1, y: 0 }
                    }}
                  >
                    {action.kind === 'link' ? (
                      <a
                        aria-label={`Open ${action.label} on port ${action.port}`}
                        className={commonClassName}
                        href={action.href}
                        rel="noreferrer"
                        target="_blank"
                        title={`Open ${action.label} (${action.port})`}
                      >
                        {content}
                      </a>
                    ) : (
                      <button
                        aria-label={
                          action.kind === 'developer-mode'
                            ? 'Open project developer trace'
                            : 'Fix Impeccable live state'
                        }
                        aria-pressed={action.kind === 'developer-mode' ? developerModeOpen : undefined}
                        className={commonClassName}
                        onClick={() => {
                          if (action.kind === 'developer-mode') setDeveloperModeOpen(true);
                          else fixImpeccable();
                        }}
                        title={
                          action.kind === 'developer-mode'
                            ? 'Open project developer trace'
                            : 'Clear Impeccable live state and reload'
                        }
                        type="button"
                      >
                        {content}
                      </button>
                    )}
                  </motion.div>
                );
              })}
            </motion.div>
          ) : null}
        </AnimatePresence>
        <motion.button
          aria-expanded={open}
          aria-label={open ? 'Close developer tools' : 'Open developer tools'}
          className={cn(
            'glass-surface flex h-12 items-center gap-2 rounded-full px-4 font-medium text-sm shadow-xl outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
            open && 'bg-accent text-accent-foreground'
          )}
          onClick={() => setOpen((value) => !value)}
          transition={prefersReducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 26 }}
          type="button"
          whileHover={prefersReducedMotion ? undefined : { scale: 1.03 }}
          whileTap={prefersReducedMotion ? undefined : { scale: 0.96 }}
        >
          <motion.span
            animate={{ rotate: open ? 45 : 0 }}
            className="grid size-7 place-items-center rounded-full bg-foreground text-background"
            transition={prefersReducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 30 }}
          >
            <HugeiconsIcon
              aria-hidden="true"
              className="size-4"
              icon={Wrench01Icon}
            />
          </motion.span>
          <span>Dev</span>
        </motion.button>
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
