import type { WorkspaceRouteProps } from '#/features/workspace/WorkspaceRoute';
import type { SessionRouteModel } from './session-route-contract';

import { removeChatRoomSessionUiState } from '@monad/atoms/workspace-experiences/session-ui-store';
import { Activity, lazy, type ReactNode, Suspense, useEffect, useMemo, useState } from 'react';

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

  useEffect(() => {
    for (const entry of storedEntries) {
      if (renderedEntries.some((candidate) => candidate.key === entry.key)) continue;
      removeSessionUiStore(entry.sessionId);
      removeChatRoomSessionUiState(entry.key);
    }
    if (!sameEntries(storedEntries, renderedEntries)) setStoredEntries(renderedEntries);
  }, [renderedEntries, storedEntries]);

  return (
    <>
      {renderedEntries.map((entry) => {
        const visible = entry.key === active?.key;
        return (
          <Activity
            key={entry.key}
            mode={visible ? 'visible' : 'hidden'}
            name={entry.key}
          >
            <Suspense fallback={visible ? <PanelLoading /> : null}>
              {entry.value.kind === 'chat' ? (
                <SessionRoute model={entry.value.model} />
              ) : (
                <WorkspaceRoute {...entry.value.props} />
              )}
            </Suspense>
          </Activity>
        );
      })}
      {active ? null : children}
    </>
  );
}
