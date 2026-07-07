import type {
  ExternalAgentObservationAccessResponse,
  ExternalAgentUsageResponse,
  NativeAgentDeliveryId,
  TranscriptTargetId
} from '@monad/protocol';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent
} from 'react';
import type { ExternalAgentStreamView, Participant } from '../../experience/types.ts';

import {
  BrainIcon,
  EyeIcon,
  FootballIcon,
  GameboyIcon,
  MegaphoneIcon,
  PencilEdit01Icon,
  PopcornIcon,
  SwimmingIcon,
  TennisBallIcon,
  Wrench01Icon,
  ZapIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useLazyGetExternalAgentHistoryPageQuery,
  useLazyGetExternalAgentUsageQuery,
  useLazyGetNativeAgentDeliveryObservationQuery,
  useStreamExternalAgentObservationQuery
} from '@monad/sdk-atom-client-rtk';
import { ProductIcon, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import {
  AgentInstanceAvatar,
  agentPresenceColor as presenceColor,
  resolveProductIcon,
  workspaceSans as sans
} from '@monad/ui/components/AgentAvatar';
import { useCallback, useEffect, useRef, useState } from 'react';

import { workspaceExperienceT } from '../../i18n.ts';
import { useChatRoomExperienceStore } from '../store.ts';
import {
  agentObservationStream,
  isActiveRailAgent,
  observationProjectionFromAccess,
  observedRailAgent,
  railAgentActivityPhase,
  shouldAnimateRailAgent,
  shouldProjectObservationAccess,
  sortedProjectRailAgents,
  streamWithObservationProjection,
  usageMeterFromObservationAccess
} from '../utils/agent-rail-model.ts';
import { ExternalAgentObservationPanel } from './observation/panel.tsx';

const RAIL_WIDTH_STORAGE_KEY = 'monad.workplace.agentRail.width';
const DEFAULT_RAIL_WIDTH = 296;
const MIN_RAIL_WIDTH = 260;
const MAX_RAIL_WIDTH = 620;

function usePolledValue<T>(args: {
  enabled: boolean;
  intervalMs: number;
  load: () => Promise<T>;
  resetKey: string;
}): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  const loadRef = useRef(args.load);
  loadRef.current = args.load;
  useEffect(() => {
    if (!args.enabled) {
      setValue(undefined);
      return;
    }
    let cancelled = false;
    const load = () => {
      void loadRef.current().then(
        (next) => {
          if (!cancelled) setValue(next);
        },
        () => {
          if (!cancelled) setValue(undefined);
        }
      );
    };
    load();
    if (args.intervalMs <= 0)
      return () => {
        cancelled = true;
      };
    const timer = window.setInterval(load, args.intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [args.enabled, args.intervalMs]);
  return value;
}

type ObservationHistoryPageState = {
  items: ExternalAgentStreamView['items'];
  nextCursor: string | null;
  loading: boolean;
  exhausted: boolean;
};

function observationItemSignature(item: ExternalAgentStreamView['items'][number]): string {
  return JSON.stringify({
    role: item.role,
    source: item.source,
    providerEventType: item.providerEventType,
    text: item.text,
    raw: item.raw
  });
}

function mergeObservationItems(
  historyItems: ExternalAgentStreamView['items'],
  liveItems: ExternalAgentStreamView['items']
): ExternalAgentStreamView['items'] {
  const seen = new Set<string>();
  const merged: ExternalAgentStreamView['items'] = [];
  for (const item of [...historyItems, ...liveItems]) {
    const signature = observationItemSignature(item);
    if (seen.has(signature)) continue;
    seen.add(signature);
    merged.push(item);
  }
  return merged;
}

function streamWithHistoryPages(
  stream: ExternalAgentStreamView | undefined,
  history: ObservationHistoryPageState | undefined
): ExternalAgentStreamView | undefined {
  if (!stream || !history || history.items.length === 0) return stream;
  return {
    ...stream,
    items: mergeObservationItems(history.items, stream.items),
    output: stream.output
  };
}

function clampRailWidth(width: number): number {
  return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(width)));
}

function agentActivityPhaseMeta(phase: NonNullable<Participant['activityPhase']>): {
  label: string;
  icon: typeof EyeIcon;
} {
  if (phase === 'reading') return { label: 'Reading', icon: EyeIcon };
  if (phase === 'speaking') return { label: 'Speaking', icon: MegaphoneIcon };
  if (phase === 'tooling') return { label: 'Using tools', icon: Wrench01Icon };
  if (phase === 'writing') return { label: 'Writing', icon: PencilEdit01Icon };
  return { label: 'Thinking', icon: BrainIcon };
}

function agentPresenceLabel(agent: Participant): string {
  if (agent.presence === 'working') return 'Working';
  if (agent.presence === 'online') return 'Online';
  if (agent.presence === 'needs-login') return 'Needs login';
  if (agent.presence === 'failed') return 'Failed';
  if (agent.presence === 'stopped') return 'Stopped';
  return 'Idle';
}

const idleAgentIcons = [
  { label: 'Popcorn', icon: PopcornIcon },
  { label: 'Game', icon: GameboyIcon },
  { label: 'Football', icon: FootballIcon },
  { label: 'Tennis', icon: TennisBallIcon },
  { label: 'Swimming', icon: SwimmingIcon }
] as const;

function stableIdleIcon(agent: Participant): (typeof idleAgentIcons)[number] {
  const key = agent.id || agent.name;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return idleAgentIcons[hash % idleAgentIcons.length] ?? idleAgentIcons[0];
}

function titleCase(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}` : value;
}

function agentMetadataRows(agent: Participant): Array<[string, string]> {
  const metadata = agent.metadata;
  return [
    ['Agent', metadata?.agent ?? agent.name],
    ['Model', metadata?.model ?? 'Default'],
    ['Effort', metadata?.effort ? titleCase(metadata.effort) : 'Default'],
    ['Speed', metadata?.speed ? titleCase(metadata.speed) : 'Standard'],
    ['Autopilot', metadata?.autopilot === false ? 'Off' : 'On']
  ];
}

const agentStatusRingCss = `
@keyframes workplace-agent-status-breathe {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--agent-presence-color) 58%, transparent); }
  50% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--agent-presence-color) 0%, transparent); }
}

@keyframes workplace-agent-status-radiate {
  0% {
    opacity: 0.72;
    transform: scale(0.9);
  }
  70%, 100% {
    opacity: 0;
    transform: scale(1.65);
  }
}

@keyframes workplace-agent-phase-thinking {
  to { transform: rotate(360deg); }
}

@keyframes workplace-agent-phase-reading {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}

@keyframes workplace-agent-phase-speaking {
  0%, 100% { transform: scale(1); }
  45% { transform: scale(1.22); }
}

@keyframes workplace-agent-phase-writing {
  0%, 100% { transform: translate(0, 0) rotate(0deg); }
  45% { transform: translate(1px, 1px) rotate(-9deg); }
}

@keyframes workplace-agent-phase-bubble-pop {
  0% {
    opacity: 0;
    transform: translate(6px, 8px) scale(0.72);
  }
  70% {
    opacity: 1;
    transform: translate(0, -1px) scale(1.04);
  }
  100% {
    opacity: 1;
    transform: translate(0, 0) scale(1);
  }
}

	@keyframes workplace-agent-phase-bubble-float {
	  0%, 100% { translate: 0 0; }
	  50% { translate: 0 -2px; }
	}

	@keyframes workplace-agent-status-dot-jump {
	  0%, 80%, 100% { transform: translateY(0); opacity: 0.42; }
	  40% { transform: translateY(-3px); opacity: 0.95; }
	}

@keyframes workplace-agent-status-sheen {
  0% { background-position: 140% 50%; }
  52%, 100% { background-position: -60% 50%; }
}

@keyframes workplace-agent-idle-icon-float {
  0%, 100% { transform: translateY(0) rotate(-2deg); opacity: 0.72; }
  50% { transform: translateY(-2px) rotate(3deg); opacity: 0.98; }
}

.workplace-agent-status-row {
  appearance: none;
	  width: 100%;
	  min-height: 92px;
  display: flex;
  position: relative;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--sidebar-border);
  border-radius: 10px;
  box-sizing: border-box;
  background: rgb(var(--backgroundColor-surface-container) / 0.36);
  color: var(--sidebar-foreground);
  font-family: var(--font-sans), ui-sans-serif, system-ui, sans-serif;
  font-size: 13px;
  line-height: 1;
  text-align: left;
  overflow: visible;
  transition: background-color 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out;
}

.workplace-agent-status-row:hover {
  background: var(--sidebar-accent);
  border-color: color-mix(in srgb, var(--sidebar-border) 58%, var(--sidebar-foreground) 42%);
  color: var(--sidebar-accent-foreground);
}

.workplace-agent-status-row[data-selected='true'] {
  background: var(--sidebar-selected);
  border-color: color-mix(in srgb, var(--sidebar-border) 48%, var(--sidebar-foreground) 52%);
  color: var(--sidebar-selected-foreground);
}

.workplace-agent-status-row[data-selected='true']:hover {
  background: var(--sidebar-selected-hover);
  border-color: color-mix(in srgb, var(--sidebar-border) 42%, var(--sidebar-foreground) 58%);
  color: var(--sidebar-selected-hover-foreground);
}

.workplace-agent-status-avatar {
  position: relative;
  display: inline-grid;
  flex: none;
  place-items: center;
  border: 1.5px solid transparent;
  border-radius: 999px;
  overflow: visible;
}

.workplace-agent-status-avatar[data-active='true'] {
  border-color: var(--agent-presence-color);
  animation: workplace-agent-status-breathe 1.8s ease-in-out infinite;
}

.workplace-agent-status-avatar[data-active='true']::after {
  position: absolute;
  inset: -3px;
  border: 1.5px solid color-mix(in srgb, var(--agent-presence-color) 72%, transparent);
  border-radius: inherit;
  content: '';
  pointer-events: none;
  animation: workplace-agent-status-radiate 1.8s ease-out infinite;
}

.workplace-agent-status-speed {
  position: absolute;
  right: -3px;
  bottom: -3px;
  z-index: 3;
  width: 17px;
  height: 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--sidebar);
  border-radius: 999px;
  background: var(--warning, #f59e0b);
  color: #1f1300;
  box-shadow: 0 3px 8px rgb(0 0 0 / 0.22);
}

.workplace-agent-status-phase {
  position: absolute;
  right: -24px;
  top: -16px;
  z-index: 4;
  width: 40px;
  height: 31px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 0 5px 4px;
  border: 0;
  background:
    center / contain no-repeat
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='-6 -7 100 82'%3E%3Cg fill='%23fff' stroke='%23332218' stroke-width='4.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='13' cy='58' r='5'/%3E%3Ccircle cx='27' cy='48' r='8'/%3E%3Cpath d='M29 42c-12-2-21-10-21-22 0-12 11-20 24-17 7-8 22-9 31-2 12-2 22 6 22 17 0 8-5 15-13 18 0 12-11 22-25 22-8 0-15-3-19-8Z'/%3E%3C/g%3E%3C/svg%3E");
  color: #332218;
  filter: drop-shadow(0 8px 10px rgb(0 0 0 / 0.18));
  transform-origin: 7px 26px;
  animation:
    workplace-agent-phase-bubble-pop 220ms cubic-bezier(0.2, 1.45, 0.38, 1) both,
    workplace-agent-phase-bubble-float 2.4s ease-in-out 220ms infinite;
}

.workplace-agent-status-phase[data-phase='thinking'] svg {
  animation: workplace-agent-phase-thinking 1.4s linear infinite;
}

.workplace-agent-status-phase[data-phase='reading'] svg {
  animation: workplace-agent-phase-reading 1.05s ease-in-out infinite;
}

.workplace-agent-status-phase[data-phase='speaking'] svg {
  animation: workplace-agent-phase-speaking 0.8s ease-in-out infinite;
}

.workplace-agent-status-phase[data-phase='tooling'] svg {
  animation: workplace-agent-phase-speaking 1s ease-in-out infinite;
}

.workplace-agent-status-phase[data-phase='writing'] svg {
  animation: workplace-agent-phase-writing 0.78s ease-in-out infinite;
}

	.workplace-agent-status-name {
	  width: auto;
	  min-width: 0;
	  flex: 1;
	  display: grid;
	  align-items: center;
	  gap: 4px;
	  color: var(--foreground);
	  line-height: 1.15;
	}

	.workplace-agent-status-title {
	  display: inline-flex;
	  align-items: center;
	  min-width: 0;
	  gap: 8px;
	  color: var(--foreground);
	  font-weight: 500;
	}

	.workplace-agent-status-title-text {
	  min-width: 0;
	  overflow: hidden;
	  text-overflow: ellipsis;
	  white-space: nowrap;
	}

	.workplace-agent-status-subtext {
	  position: relative;
	  width: fit-content;
	  max-width: 100%;
	  display: inline-flex;
	  align-items: center;
	  gap: 1px;
	  overflow: hidden;
	  color: color-mix(in srgb, var(--sidebar-foreground) 72%, transparent);
	  font-size: 11px;
	  font-weight: 400;
	  line-height: 14px;
	  white-space: nowrap;
	}

	.workplace-agent-status-subtext[data-active='true'] {
	  color: color-mix(in srgb, var(--agent-presence-color) 78%, var(--sidebar-foreground) 22%);
	}

	.workplace-agent-status-subtext[data-active='true']::after {
	  position: absolute;
	  inset: -2px -12px;
	  content: '';
	  pointer-events: none;
	  background: linear-gradient(105deg, transparent 30%, rgb(255 255 255 / 0.34) 48%, transparent 64%);
	  background-size: 240% 100%;
	  mix-blend-mode: screen;
	  animation: workplace-agent-status-sheen 2.1s cubic-bezier(0.19, 1, 0.22, 1) infinite;
	}

	.workplace-agent-status-ellipsis {
	  display: inline-flex;
	  align-items: flex-end;
	  gap: 1px;
	  padding-left: 1px;
	}

	.workplace-agent-status-dot {
	  width: 2px;
	  height: 2px;
	  border-radius: 999px;
	  background: currentColor;
	}

	.workplace-agent-status-subtext[data-active='true'] .workplace-agent-status-dot {
	  animation: workplace-agent-status-dot-jump 1.05s ease-in-out infinite;
	}

	.workplace-agent-status-subtext[data-active='true'] .workplace-agent-status-dot:nth-child(2) {
	  animation-delay: 120ms;
	}

.workplace-agent-status-subtext[data-active='true'] .workplace-agent-status-dot:nth-child(3) {
  animation-delay: 240ms;
}

.workplace-agent-status-idle-icon {
  display: inline-flex;
  align-items: center;
  color: color-mix(in srgb, var(--sidebar-foreground) 72%, transparent);
  transform-origin: 50% 70%;
  animation: workplace-agent-idle-icon-float 2.2s ease-in-out infinite;
}

.workplace-agent-status-product {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.workplace-agent-status-tooltip {
  min-width: 168px;
  display: grid;
  gap: 5px;
  padding: 8px 10px;
  font-family: var(--font-sans), ui-sans-serif, system-ui, sans-serif;
}

.workplace-agent-status-tooltip-row {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  align-items: baseline;
  gap: 10px;
}

.workplace-agent-status-tooltip-label {
  color: var(--muted-foreground);
}

.workplace-agent-status-tooltip-value {
  min-width: 0;
  overflow: hidden;
  color: var(--foreground);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
	  .workplace-agent-status-avatar,
	  .workplace-agent-status-avatar::after,
	  .workplace-agent-status-phase,
	  .workplace-agent-status-phase svg,
	  .workplace-agent-status-subtext::after,
	  .workplace-agent-status-subtext,
	  .workplace-agent-status-dot,
	  .workplace-agent-status-idle-icon {
	    animation: none;
	  }

	  .workplace-agent-status-subtext[data-active='true'] {
	    color: color-mix(in srgb, var(--sidebar-foreground) 72%, transparent);
	  }

	  .workplace-agent-status-subtext[data-active='true']::after {
	    content: none;
	  }
	}
`;

type AgentTasksRailRoom = {
  externalAgentStreams: ExternalAgentStreamView[];
  projectId: string;
  railAgents: Participant[];
  stopExternalAgent: (id: string) => void;
};

export function AgentTasksRail({ room }: { room: AgentTasksRailRoom }): React.ReactElement {
  const t = workspaceExperienceT();
  const [triggerNativeAgentDeliveryObservation] = useLazyGetNativeAgentDeliveryObservationQuery();
  const [triggerExternalAgentHistoryPage] = useLazyGetExternalAgentHistoryPageQuery();
  const [triggerExternalAgentUsage] = useLazyGetExternalAgentUsageQuery();
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL_WIDTH);
  const [resizing, setResizing] = useState(false);
  const dragStartRef = useRef({ pointerX: 0, width: DEFAULT_RAIL_WIDTH });
  const suppressMouseResizeRef = useRef(false);
  const effectiveRailWidth = railWidth;
  const observation = useChatRoomExperienceStore((state) =>
    state.railObservation?.projectId === room.projectId ? state.railObservation : null
  );
  const observeProjectAgent = useChatRoomExperienceStore((state) => state.observeProjectAgent);
  const closeRailObservation = useChatRoomExperienceStore((state) => state.closeRailObservation);
  const agents = sortedProjectRailAgents(room.railAgents);
  const observedStream = agentObservationStream(observation, room.externalAgentStreams);
  const observedExternalAgentSessionId = observation?.externalAgentSessionId ?? observedStream?.id;
  const observedDeliveryId = observation?.deliveryId;
  const observationHistoryResetKey = [observedDeliveryId, observedExternalAgentSessionId].filter(Boolean).join(':');
  const [historyPages, setHistoryPages] = useState<ObservationHistoryPageState | undefined>(undefined);
  const [historyRequested, setHistoryRequested] = useState(false);
  // External agent observation is a server-pushed SSE stream (per-token `append` deltas folded into a full
  // `output`), not a 900ms poll — a live turn streams into the panel without waiting on a refetch.
  // Deliveries have no SSE twin yet, so they keep the poll.
  const externalAgentObservation = useStreamExternalAgentObservationQuery(
    { id: observedExternalAgentSessionId ?? '', transcriptTargetId: room.projectId as TranscriptTargetId },
    { skip: !(observedExternalAgentSessionId && observation && !observedDeliveryId) }
  );
  const deliveryObservation = usePolledValue<ExternalAgentObservationAccessResponse>({
    enabled: Boolean(observedDeliveryId && observation),
    intervalMs: observedStream?.status === 'running' ? 900 : 0,
    load: () =>
      triggerNativeAgentDeliveryObservation({
        id: observedDeliveryId as NativeAgentDeliveryId,
        transcriptTargetId: room.projectId as TranscriptTargetId
      }).unwrap(),
    resetKey: `${room.projectId}:${observedDeliveryId ?? ''}`
  });
  const observationAccess = observedDeliveryId ? deliveryObservation : (externalAgentObservation.data ?? undefined);
  const observedBaseStream: ExternalAgentStreamView | undefined =
    observedStream ??
    (observation && observedExternalAgentSessionId
      ? {
          id: observedExternalAgentSessionId,
          agentName: observation.agentName ?? observationAccess?.externalAgentSessionId ?? 'Agent',
          provider: observationAccess?.provider ?? 'external-agent',
          tag: 'Agent',
          status: 'ok',
          output: '',
          items: []
        }
      : undefined);
  const projectObservationAccess = shouldProjectObservationAccess({
    access: observationAccess,
    deliveryId: observedDeliveryId,
    historyRequested
  });
  const observationProjection = projectObservationAccess
    ? observationProjectionFromAccess(observedBaseStream, observationAccess, observedDeliveryId)
    : undefined;
  const observedAccessStream = streamWithObservationProjection(observedBaseStream, observationProjection);
  const observedHistoryStream = streamWithHistoryPages(observedAccessStream, historyPages);
  const observedUsageAgentName = observedAccessStream?.templateAgentName;
  const usage = usePolledValue<ExternalAgentUsageResponse>({
    enabled: Boolean(observedUsageAgentName),
    intervalMs: observedAccessStream?.status === 'running' ? 15_000 : 0,
    load: () => triggerExternalAgentUsage(observedUsageAgentName as string).unwrap(),
    resetKey: observedUsageAgentName ?? ''
  });
  const usageMeter = usageMeterFromObservationAccess({
    access: observationAccess,
    provider: observedAccessStream?.provider,
    stream: observedStream,
    usage
  });
  const observedAgent = observedRailAgent(observation, observedStream, room.railAgents);

  const loadHistoryPage = useCallback(
    (before?: string | null) => {
      if (!observedExternalAgentSessionId) return;
      setHistoryPages((current) => {
        if (current?.loading) return current;
        return current
          ? { ...current, loading: true }
          : { items: [], nextCursor: null, loading: true, exhausted: false };
      });
      void triggerExternalAgentHistoryPage({
        id: observedExternalAgentSessionId,
        transcriptTargetId: room.projectId as TranscriptTargetId,
        before: before ?? undefined,
        limit: 20
      })
        .unwrap()
        .then(
          (response) => {
            // The daemon already knows this session's provider unambiguously and normalizes with the
            // same adapter it uses for parseOutput/historyPageOutput — no client-side re-derivation.
            const pageItems = response.events;
            setHistoryPages((current) => {
              const existing = current?.items ?? [];
              const nextItems = before
                ? mergeObservationItems(pageItems, existing)
                : mergeObservationItems(pageItems, []);
              return {
                items: nextItems,
                nextCursor: response.nextCursor ?? null,
                loading: false,
                exhausted: !response.nextCursor || pageItems.length === 0
              };
            });
          },
          () => {
            setHistoryPages((current) => ({
              items: current?.items ?? [],
              nextCursor: current?.nextCursor ?? null,
              loading: false,
              exhausted: true
            }));
          }
        );
    },
    [observedExternalAgentSessionId, room.projectId, triggerExternalAgentHistoryPage]
  );

  const showHistory = useCallback(() => {
    if (historyRequested || !observedExternalAgentSessionId) return;
    setHistoryRequested(true);
    loadHistoryPage(null);
  }, [historyRequested, loadHistoryPage, observedExternalAgentSessionId]);

  useEffect(() => {
    void observationHistoryResetKey;
    setHistoryPages(undefined);
    setHistoryRequested(false);
  }, [observationHistoryResetKey]);

  useEffect(() => {
    const storedWidth = window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY);
    if (!storedWidth) return;
    const nextWidth = Number.parseInt(storedWidth, 10);
    if (Number.isFinite(nextWidth)) setRailWidth(clampRailWidth(nextWidth));
  }, []);

  const setMeasuredRailWidth = useCallback((width: number) => {
    const nextWidth = clampRailWidth(width);
    setRailWidth(nextWidth);
    window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(nextWidth));
  }, []);

  const beginResize = useCallback(
    ({
      cancelEvent,
      clientX,
      moveEvent,
      upEvent
    }: {
      cancelEvent?: 'pointercancel';
      clientX: number;
      moveEvent: 'mousemove' | 'pointermove';
      upEvent: 'mouseup' | 'pointerup';
    }) => {
      dragStartRef.current = { pointerX: clientX, width: effectiveRailWidth };
      setResizing(true);

      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.documentElement.dataset.sidebarResizing = 'true';

      const onResizeMove = (resizeEvent: MouseEvent | PointerEvent) => {
        setMeasuredRailWidth(dragStartRef.current.width + dragStartRef.current.pointerX - resizeEvent.clientX);
      };
      const onResizeEnd = () => {
        setResizing(false);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        delete document.documentElement.dataset.sidebarResizing;
        window.removeEventListener(moveEvent, onResizeMove);
        window.removeEventListener(upEvent, onResizeEnd);
        if (cancelEvent) window.removeEventListener(cancelEvent, onResizeEnd);
      };

      window.addEventListener(moveEvent, onResizeMove);
      window.addEventListener(upEvent, onResizeEnd);
      if (cancelEvent) window.addEventListener(cancelEvent, onResizeEnd);
    },
    [effectiveRailWidth, setMeasuredRailWidth]
  );

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLHRElement>) => {
      event.preventDefault();
      suppressMouseResizeRef.current = true;
      window.setTimeout(() => {
        suppressMouseResizeRef.current = false;
      }, 0);
      beginResize({
        cancelEvent: 'pointercancel',
        clientX: event.clientX,
        moveEvent: 'pointermove',
        upEvent: 'pointerup'
      });
    },
    [beginResize]
  );

  const onResizeMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLHRElement>) => {
      if (event.button !== 0 || suppressMouseResizeRef.current) return;
      event.preventDefault();
      beginResize({ clientX: event.clientX, moveEvent: 'mousemove', upEvent: 'mouseup' });
    },
    [beginResize]
  );

  const onResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLHRElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End')
        return;
      event.preventDefault();
      if (event.key === 'Home') setMeasuredRailWidth(MIN_RAIL_WIDTH);
      else if (event.key === 'End') setMeasuredRailWidth(MAX_RAIL_WIDTH);
      else setMeasuredRailWidth(effectiveRailWidth + (event.key === 'ArrowLeft' ? 12 : -12));
    },
    [effectiveRailWidth, setMeasuredRailWidth]
  );

  const observeAgent = useCallback(
    (agent: Participant) => {
      observeProjectAgent(room.projectId, { agentId: agent.id, agentName: agent.name });
    },
    [observeProjectAgent, room.projectId]
  );

  const renderAgent = (agent: Participant) => {
    const productIcon = resolveProductIcon(agent);
    const active = isActiveRailAgent(agent);
    const shouldAnimate = shouldAnimateRailAgent(agent);
    const activityPhase = railAgentActivityPhase(agent);
    const phase = activityPhase ? agentActivityPhaseMeta(activityPhase) : undefined;
    const PhaseIcon = phase?.icon;
    const statusLabel = phase?.label ?? agentPresenceLabel(agent);
    const idleStatusIcon =
      !phase && (agent.presence === 'idle' || agent.presence === 'online') ? stableIdleIcon(agent) : undefined;
    const IdleStatusIcon = idleStatusIcon?.icon;
    const fastMode = agent.metadata?.speed === 'fast';
    const metadataRows = agentMetadataRows(agent);
    const productBadge = productIcon ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="workplace-agent-status-product">
            <ProductIcon
              product={productIcon}
              size={12}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent
          className="workplace-agent-status-tooltip"
          side="top"
          sideOffset={8}
        >
          {metadataRows.map(([label, value]) => (
            <span
              className="workplace-agent-status-tooltip-row"
              key={label}
            >
              <span className="workplace-agent-status-tooltip-label">{label}</span>
              <span
                className="workplace-agent-status-tooltip-value"
                title={value}
              >
                {value}
              </span>
            </span>
          ))}
        </TooltipContent>
      </Tooltip>
    ) : null;
    return (
      <button
        aria-label={phase ? `Observe ${agent.name}, ${phase.label}` : `Observe ${agent.name}`}
        aria-pressed={observedAgent?.id === agent.id}
        className="workplace-action workplace-agent-status-row"
        data-selected={observedAgent?.id === agent.id}
        key={agent.id}
        onClick={() => observeAgent(agent)}
        style={{ '--agent-presence-color': presenceColor(agent.presence) } as CSSProperties}
        type="button"
      >
        <span
          className="workplace-agent-status-avatar"
          data-active={shouldAnimate ? 'true' : undefined}
        >
          <AgentInstanceAvatar
            agent={agent}
            bordered={active}
            size={42}
          />
          {fastMode ? (
            <span
              aria-label="Fast mode enabled"
              className="workplace-agent-status-speed"
              role="img"
              title="Fast mode enabled"
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={ZapIcon}
                size={10}
                strokeWidth={2.5}
              />
            </span>
          ) : null}
          {phase && PhaseIcon ? (
            <span
              className="workplace-agent-status-phase"
              data-phase={activityPhase}
              title={phase.label}
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={PhaseIcon}
                size={13}
                strokeWidth={1.8}
              />
            </span>
          ) : null}
        </span>
        <span className="workplace-agent-status-name">
          <span className="workplace-agent-status-title">
            <span
              className="workplace-agent-status-title-text"
              title={agent.name}
            >
              {agent.name}
            </span>
            {productBadge}
          </span>
          <span
            className="workplace-agent-status-subtext"
            data-active={phase ? 'true' : undefined}
            title={statusLabel}
          >
            {IdleStatusIcon ? (
              <span
                aria-label={`${statusLabel}: ${idleStatusIcon.label}`}
                className="workplace-agent-status-idle-icon"
                role="img"
              >
                <HugeiconsIcon
                  aria-hidden="true"
                  icon={IdleStatusIcon}
                  size={14}
                  strokeWidth={1.8}
                />
              </span>
            ) : (
              <span>{statusLabel}</span>
            )}
            {phase ? (
              <span
                aria-hidden="true"
                className="workplace-agent-status-ellipsis"
              >
                <span className="workplace-agent-status-dot" />
                <span className="workplace-agent-status-dot" />
                <span className="workplace-agent-status-dot" />
              </span>
            ) : null}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div
      className="scwf-scroll workplace-agent-rail"
      data-resizing={resizing}
      style={{
        width: effectiveRailWidth,
        flex: 'none',
        borderLeft: `1px solid ${'var(--sidebar-border)'}`,
        background: 'var(--sidebar)',
        minHeight: 0,
        overflow: 'visible',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative'
      }}
    >
      <style>{agentStatusRingCss}</style>
      <hr
        aria-label={t('web.workplace.resizeProjectSidebar')}
        aria-orientation="vertical"
        aria-valuemax={MAX_RAIL_WIDTH}
        aria-valuemin={MIN_RAIL_WIDTH}
        aria-valuenow={effectiveRailWidth}
        className="workplace-agent-rail-resize-handle"
        data-preserve-cursor="true"
        onKeyDown={onResizeKeyDown}
        onMouseDown={onResizeMouseDown}
        onPointerDown={onResizePointerDown}
        tabIndex={0}
      />
      {observation ? (
        <ExternalAgentObservationPanel
          agent={observedAgent}
          agentName={observedAgent?.name ?? observation.agentName}
          canLoadOlderHistory={
            historyRequested && Boolean(historyPages?.nextCursor) && !historyPages?.loading && !historyPages?.exhausted
          }
          focusTurnId={observation.turnId}
          icon={observedAgent?.icon ?? observedHistoryStream?.icon}
          loadingOlderHistory={historyPages?.loading}
          onBack={closeRailObservation}
          onLoadOlderHistory={() => loadHistoryPage(historyPages?.nextCursor)}
          onShowHistory={showHistory}
          onStop={(id) => void room.stopExternalAgent(id)}
          showHistoryButton={!historyRequested && Boolean(observedExternalAgentSessionId)}
          stream={observedHistoryStream}
          usageMeter={usageMeter}
        />
      ) : (
        <div
          className="scwf-scroll"
          style={{
            padding: '14px',
            display: agents.length === 0 ? 'flex' : 'grid',
            flexDirection: agents.length === 0 ? 'column' : undefined,
            gridTemplateColumns: agents.length === 0 ? undefined : 'repeat(auto-fit, minmax(156px, 1fr))',
            alignContent: agents.length === 0 ? undefined : 'start',
            gap: 10,
            flex: 1,
            minHeight: 0,
            overflowY: 'auto'
          }}
        >
          {agents.length === 0 ? (
            <div
              style={{
                fontFamily: sans,
                fontSize: 13,
                color: 'var(--sidebar-foreground)',
                padding: '2px 0',
                lineHeight: 1.5,
                opacity: 0.6
              }}
            >
              {t('web.workplace.noStandByAgents')}
            </div>
          ) : null}
          {agents.map(renderAgent)}
        </div>
      )}
    </div>
  );
}
