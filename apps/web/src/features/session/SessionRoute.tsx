import type { CSSProperties, ReactNode } from 'react';
import type { SessionRouteModel } from './session-route-contract';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { SkillEditorDialog } from '#/features/studio/skills-settings/SkillEditorDialog';
import { loadSkillContent } from '#/features/studio/skills-settings/utils';
import { useMonadRuntime } from '#/lib/monad-runtime-context';
import { skillCommandMeta } from './command-menu';
import { SessionComposerRegion } from './SessionComposerRegion';
import { SessionHeader } from './SessionHeader';
import { SessionInspectorRegion } from './SessionInspectorRegion';
import { SessionTranscript } from './SessionTranscript';
import { SessionProvider } from './session-context';
import { useSessionUiStore } from './session-ui-store';

export function SessionRoute({ model }: { model: SessionRouteModel }) {
  const t = useT();
  const { client: monadClient } = useMonadRuntime();
  const skillPreview = useSessionUiStore((state) => state.skillPreview);
  const setSkillPreview = useSessionUiStore((state) => state.setSkillPreview);
  const openSkillPreview = useCallback(
    async (id: string) => {
      const command = model.commands.find((item) => item.type === 'skill' && item.id === id);
      const meta = skillCommandMeta(command, t);
      if (!command || !meta) return;
      const content = await loadSkillContent({ id: command.id, name: command.name }, monadClient).catch(() => null);
      if (content) setSkillPreview({ id: command.id, name: content.name, title: meta.label, content: content.content });
    },
    [model.commands, monadClient, setSkillPreview, t]
  );
  const sessionContext = useMemo(
    () => ({
      commands: model.commands,
      identity: model.identity,
      onSkillPreview: (id: string) => void openSkillPreview(id)
    }),
    [model.commands, model.identity, openSkillPreview]
  );

  if (model.identity.isDeleted) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-muted-foreground text-sm">
        {t('web.sidebar.sessionDeleted')}
      </div>
    );
  }

  return (
    <SessionProvider value={sessionContext}>
      <SessionConversationLayout
        composer={<SessionComposerRegion model={model.composer} />}
        header={<SessionHeader />}
        inspector={<SessionInspectorRegion inspector={model.inspector} />}
        transcript={<SessionTranscript model={model.transcript} />}
      />
      <SkillEditorDialog
        editor={skillPreview}
        initialView="preview"
        lockedPreview
        onClose={() => setSkillPreview(null)}
        onSaved={() => setSkillPreview(null)}
      />
    </SessionProvider>
  );
}

function SessionConversationLayout({
  composer,
  header,
  inspector,
  transcript
}: {
  composer: ReactNode;
  header: ReactNode;
  inspector: ReactNode;
  transcript: ReactNode;
}) {
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(132);
  const bodyStyle = useMemo(
    () =>
      ({
        '--session-composer-clearance': `${composerHeight}px`
      }) as CSSProperties,
    [composerHeight]
  );

  useEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    const updateComposerHeight = () => setComposerHeight(Math.ceil(node.getBoundingClientRect().height));
    updateComposerHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const resizeObserver = new ResizeObserver(updateComposerHeight);
    resizeObserver.observe(node);
    return () => resizeObserver.disconnect();
  }, []);

  return (
    <>
      {header}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className="relative flex min-h-0 flex-1 overflow-hidden"
          style={bodyStyle}
        >
          {transcript}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-12"
            ref={composerRef}
            style={{
              background:
                'linear-gradient(to top, rgb(var(--backgroundColor-primary) / 1) 0%, rgb(var(--backgroundColor-primary) / 1) calc(100% - 64px), rgb(var(--backgroundColor-primary) / 0) 100%)'
            }}
          >
            <div className="pointer-events-auto">{composer}</div>
          </div>
        </div>
        {inspector}
      </div>
    </>
  );
}
