import type { WorkplaceExperienceDefinition, WorkplaceExperienceEntry } from '@monad/protocol';
import type { WorkplaceExperienceHostApiV1 } from '@monad/sdk-experience';
import type { WorkplaceExperienceFailure } from '../failure';
import type { ProjectExperienceView } from '../types';

import { WORKPLACE_EXPERIENCE_API_VERSION } from '@monad/sdk-experience';
import { createElement, useEffect, useMemo, useRef, useState } from 'react';

import { projectSessionPath, studioPath } from '#/features/shell/routing/paths';
import { pushShellUrl } from '#/hooks/use-shell-location';
import { useMonadRuntime } from '#/lib/monad-runtime-context';
import { daemonApiUrl } from '#/lib/monad-store';
import { WorkplaceExperienceFailureView } from '../WorkplaceExperienceFailureView';

type WorkplaceExperienceElement = HTMLElement & {
  monadWorkplaceExperience?: WorkplaceExperienceHostApiV1;
};

type WebComponentWorkplaceExperienceDefinition = WorkplaceExperienceDefinition & {
  entry: Extract<WorkplaceExperienceEntry, { type: 'web-component' }>;
};

const moduleLoads = new Map<string, Promise<void>>();

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

function loadWebComponentModule(module: string): Promise<void> {
  const existing = moduleLoads.get(module);
  if (existing) return existing;

  const load = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = module;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error(`failed to load workplace experience module: ${module}`)), {
      once: true
    });
    document.head.append(script);
  }).catch((error) => {
    moduleLoads.delete(module);
    throw error;
  });

  moduleLoads.set(module, load);
  return load;
}

export function WebComponentExperience({
  atom,
  view
}: {
  atom: WebComponentWorkplaceExperienceDefinition;
  view: ProjectExperienceView;
}) {
  const { baseUrl: daemonBaseUrl } = useMonadRuntime();
  const ref = useRef<WorkplaceExperienceElement | null>(null);
  const [failure, setFailure] = useState<WorkplaceExperienceFailure | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const hostApi = useMemo<WorkplaceExperienceHostApiV1>(
    () => ({
      version: WORKPLACE_EXPERIENCE_API_VERSION,
      actions: {
        ...view.runtime.actions,
        openProjectSession: (sessionId) => pushShellUrl(projectSessionPath(view.runtime.snapshot.projectId, sessionId))
      },
      apiBaseUrl: daemonApiUrl(daemonBaseUrl, `/v1/atoms/workplace-experiences/${encodeURIComponent(atom.id)}/api`),
      embedded: view.embedded,
      voiceModelState: view.voiceModelState,
      requestProjectDialog: view.onProjectDialogRequest ?? (() => {}),
      resolveAgentIdentity: view.resolveAgentIdentity,
      openStudio: (section = 'models') => pushShellUrl(studioPath(section)),
      snapshot: view.runtime.snapshot
    }),
    [
      atom.id,
      daemonBaseUrl,
      view.embedded,
      view.onProjectDialogRequest,
      view.resolveAgentIdentity,
      view.runtime.actions,
      view.runtime.snapshot,
      view.voiceModelState
    ]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt is the retry trigger — a dependency the body deliberately never reads, so `Try again` re-runs the load.
  useEffect(() => {
    let active = true;
    setFailure(null);
    if (!isSameOriginModule(atom.entry.module)) {
      setFailure({ category: 'activation', detail: atom.entry.module });
      return () => {
        active = false;
      };
    }
    void loadWebComponentModule(atom.entry.module)
      .then(() => {
        // The module resolved but never defined the element the definition names — the experience
        // is unusable, and without this check it would mount as an inert unknown element.
        if (!active || customElements.get(atom.entry.tagName)) return;
        setFailure({ category: 'component-load', detail: atom.entry.tagName });
      })
      .catch((err) => {
        if (!active) return;
        setFailure({ category: 'availability', detail: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      active = false;
    };
  }, [atom.entry.module, atom.entry.tagName, loadAttempt]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.monadWorkplaceExperience = hostApi;
    node.dispatchEvent(new CustomEvent('monad-workplace-experience:update', { detail: hostApi }));
  }, [hostApi]);

  if (!isValidCustomElementName(atom.entry.tagName)) {
    return <WorkplaceExperienceFailureView failure={{ category: 'invalid-definition', detail: atom.entry.tagName }} />;
  }
  if (failure) {
    return (
      <WorkplaceExperienceFailureView
        failure={failure}
        onRetry={() => {
          moduleLoads.delete(atom.entry.module);
          setLoadAttempt((attempt) => attempt + 1);
        }}
      />
    );
  }

  return (
    <div className="workplace-experience-host">
      <style>{`
        .workplace-experience-host {
          flex: 1;
          min-width: 0;
          min-height: 0;
          display: flex;
          background: var(--card);
        }
        .workplace-experience-host > [data-experience-id] {
          flex: 1;
          min-width: 0;
          min-height: 0;
          display: block;
        }
      `}</style>
      {createElement(atom.entry.tagName, {
        ref,
        'data-experience-id': atom.id
      })}
    </div>
  );
}
