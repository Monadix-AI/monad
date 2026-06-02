import type { SessionAttentionState, SessionGenerationState } from '@monad/protocol';

import { Alert01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { SidebarAttentionBadge } from './sidebar-attention-badge';
import { useWorkspaceSidebar } from './workspace-sidebar-context';

export type SessionSidebarStatus = SessionAttentionState | SessionGenerationState;

export function resolveSessionSidebarStatus({
  attentionState,
  generationState
}: {
  attentionState?: SessionAttentionState | null;
  generationState?: SessionGenerationState | null;
}): SessionSidebarStatus | null {
  if (attentionState === 'need-approval' || attentionState === 'need-response') return attentionState;
  if (generationState === 'error') return generationState;
  if (generationState === 'running') return generationState;
  return attentionState === 'unread' ? attentionState : null;
}

export function SessionStatusMarker({
  attentionState,
  generationState
}: {
  attentionState?: SessionAttentionState | null;
  generationState?: SessionGenerationState | null;
}) {
  const { meta } = useWorkspaceSidebar();
  const status = resolveSessionSidebarStatus({ attentionState, generationState });
  if (!status) return null;
  if (status === 'running') {
    return (
      <span className="flex shrink-0 items-center">
        <span className="sr-only">{meta.t('web.sidebar.generating')}</span>
        <span
          aria-hidden="true"
          className="size-3 animate-spin rounded-full border-[1.5px] border-muted-foreground/35 border-t-muted-foreground motion-reduce:animate-none"
        />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex shrink-0 items-center text-destructive">
        <span className="sr-only">{meta.t('web.sidebar.generationFailed')}</span>
        <HugeiconsIcon
          aria-hidden="true"
          className="size-3.5"
          icon={Alert01Icon}
        />
      </span>
    );
  }
  if (status === 'unread') {
    return (
      <span className="flex shrink-0 items-center">
        <span className="sr-only">{meta.t('web.sidebar.unread')}</span>
        <span
          aria-hidden="true"
          className="size-2 rounded-full bg-primary"
        />
      </span>
    );
  }
  const label = meta.t(status === 'need-approval' ? 'web.sidebar.needApproval' : 'web.sidebar.needResponse');
  return <SidebarAttentionBadge state={status}>{label}</SidebarAttentionBadge>;
}
