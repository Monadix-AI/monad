'use client';

import type {
  WorkspaceExperienceDefinition,
  WorkspaceExperienceEntry,
  WorkspaceExperienceHostApi
} from '@monad/protocol';
import type { ProjectExperienceView } from '../types';

import { createElement, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '@/components/I18nProvider';

type WorkspaceExperienceElement = HTMLElement & {
  monadWorkspaceExperience?: WorkspaceExperienceHostApi;
};

type WebComponentWorkspaceExperienceDefinition = WorkspaceExperienceDefinition & {
  entry: Extract<WorkspaceExperienceEntry, { type: 'web-component' }>;
};

function isValidCustomElementName(name: string): boolean {
  return /^[a-z][.0-9_a-z-]*-[.0-9_a-z-]*$/.test(name);
}

function isSameOriginModule(module: string): boolean {
  try {
    return new URL(module, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function WebComponentExperience({
  atom,
  view
}: {
  atom: WebComponentWorkspaceExperienceDefinition;
  view: ProjectExperienceView;
}) {
  const t = useT();
  const ref = useRef<WorkspaceExperienceElement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const hostApi = useMemo(
    () => ({
      // TODO: add per-atom API permission controls before third-party workspace experiences ship.
      actions: view.runtime.actions,
      apiBaseUrl: `/api/v1/atoms/workspace-experiences/${encodeURIComponent(atom.id)}/api`,
      embedded: view.embedded,
      requestProjectDialog: view.onProjectDialogRequest ?? (() => {}),
      snapshot: view.runtime.snapshot
    }),
    [atom.id, view.embedded, view.onProjectDialogRequest, view.runtime.actions, view.runtime.snapshot]
  );

  useEffect(() => {
    let active = true;
    setLoadError(null);
    if (!isSameOriginModule(atom.entry.module)) {
      setLoadError('workspace experience module must be same-origin');
      return () => {
        active = false;
      };
    }
    void import(/* webpackIgnore: true */ atom.entry.module).catch((err) => {
      if (!active) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      active = false;
    };
  }, [atom.entry.module]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.monadWorkspaceExperience = hostApi;
    node.dispatchEvent(new CustomEvent('monad-workspace-experience:update', { detail: hostApi }));
  }, [hostApi]);

  if (!isValidCustomElementName(atom.entry.tagName)) {
    return <div className="workspace-experience-error">Invalid workspace experience element: {atom.entry.tagName}</div>;
  }

  return (
    <div className="workspace-experience-host">
      <style>{`
        .workspace-experience-host {
          flex: 1;
          min-width: 0;
          min-height: 0;
          display: flex;
          background: var(--card);
        }
        .workspace-experience-host > * {
          flex: 1;
          min-width: 0;
          min-height: 0;
          display: block;
        }
        .workspace-experience-error {
          flex: 1;
          display: grid;
          place-items: center;
          color: var(--muted-foreground);
          font-size: 12px;
        }
      `}</style>
      {loadError ? <div className="workspace-experience-error">{t('web.workplace.experienceLoadFailed')}</div> : null}
      {createElement(atom.entry.tagName, {
        ref,
        'data-experience-id': atom.id,
        hidden: loadError ? true : undefined
      })}
    </div>
  );
}
