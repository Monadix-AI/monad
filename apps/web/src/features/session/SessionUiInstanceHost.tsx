import type { WorkspaceRouteProps } from '#/features/workspace/WorkspaceRoute';
import type { SessionRouteModel } from './session-route-contract';

import { removeChatRoomSessionUiState } from '@monad/atoms/workplace-experiences/session-ui-store';
import { lazy, memo, type ReactNode, Suspense, useEffect, useMemo, useState } from 'react';

import { PanelLoading } from '#/components/PanelLoading';
import { WorkspaceRoute } from '#/features/workspace/WorkspaceRoute';
import {
  activateSessionUiInstance,
  pruneSessionUiInstances,
  type SessionUiInstance
} from './session-ui-instance-cache';
import { removeSessionUiStore } from './session-ui-store';

const SessionRoute = lazy(() => import('./SessionRoute').then((module) => ({ default: module.SessionRoute })));

export type SessionUiSurface =
  | {
      key: `chat:${string}`;
      kind: 'chat';
      model: SessionRouteModel;
      sessionId: string;
    }
  | {
      key: `project:${string}:session:${string}`;
      kind: 'project';
      props: WorkspaceRouteProps;
      sessionId: string;
    };

const SessionUiInstancePane = memo(function SessionUiInstancePane({
  surface,
  visible
}: {
  surface: SessionUiSurface;
  visible: boolean;
}) {
  return (
    <div
      aria-hidden={!visible}
      className="absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden"
      data-session-ui-instance={surface.key}
      inert={visible ? undefined : true}
      style={{ pointerEvents: visible ? undefined : 'none', visibility: visible ? 'visible' : 'hidden' }}
    >
      <Suspense fallback={visible ? <PanelLoading /> : null}>
        {surface.kind === 'chat' ? <SessionRoute model={surface.model} /> : <WorkspaceRoute {...surface.props} />}
      </Suspense>
    </div>
  );
});

function sameEntries(
  left: SessionUiInstance<SessionUiSurface>[],
  right: SessionUiInstance<SessionUiSurface>[]
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry.key === right[index]?.key && entry.value === right[index]?.value)
  );
}

export function SessionUiInstanceHost({
  active,
  activeSessionIds,
  children
}: {
  active: SessionUiSurface | null;
  activeSessionIds: ReadonlySet<string>;
  children: ReactNode;
}) {
  const [storedEntries, setStoredEntries] = useState<SessionUiInstance<SessionUiSurface>[]>([]);
  const renderedEntries = useMemo(() => {
    const validEntries = pruneSessionUiInstances(storedEntries, activeSessionIds);
    if (!active) return validEntries;
    return activateSessionUiInstance(validEntries, {
      key: active.key,
      sessionId: active.sessionId,
      value: active
    });
  }, [active, activeSessionIds, storedEntries]);
  const mountedEntries = useMemo(
    () => [...renderedEntries].sort((left, right) => left.key.localeCompare(right.key)),
    [renderedEntries]
  );

  useEffect(() => {
    for (const entry of storedEntries) {
      if (renderedEntries.some((candidate) => candidate.key === entry.key)) continue;
      removeSessionUiStore(entry.sessionId);
      removeChatRoomSessionUiState(entry.key);
    }
    if (!sameEntries(storedEntries, renderedEntries)) setStoredEntries(renderedEntries);
  }, [renderedEntries, storedEntries]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {mountedEntries.map((entry) => {
        const visible = entry.key === active?.key;
        return (
          <SessionUiInstancePane
            key={entry.key}
            surface={entry.value}
            visible={visible}
          />
        );
      })}
      {active ? null : children}
    </div>
  );
}
