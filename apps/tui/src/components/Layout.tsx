import type { MonadClient } from '@monad/client';
import type { RootState } from '../store/index.ts';

import { Box, Text, useInput } from 'ink';
import { useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';

import { HostInteractionPrompt, useTuiInteractionPresenter } from '../interactions/presenter.tsx';
import { t } from '../lib/i18n.ts';
import { useUIStore } from '../store/ui.ts';
import { Composer } from './Composer.tsx';
import { ModelSettings } from './ModelSettings.tsx';
import { SessionPicker } from './SessionPicker.tsx';
import { Transcript } from './Transcript.tsx';
import { TUI_GLYPHS, TUI_THEME } from './theme.ts';

export function Layout({ client }: { client: MonadClient }) {
  const interactionPresenter = useTuiInteractionPresenter(client);
  const overlay = useUIStore((s) => s.overlay);
  const setOverlay = useUIStore((s) => s.setOverlay);
  const overlayBeforeInteraction = useRef<typeof overlay>('none');
  const currentSessionId = useSelector((s: RootState) => s.server.currentSessionId);
  const sessions = useSelector((s: RootState) => s.server.sessions);
  const currentSession = sessions.find((s) => s.id === currentSessionId);

  useEffect(() => {
    if (interactionPresenter.active && overlay !== 'interaction') {
      overlayBeforeInteraction.current = overlay;
      setOverlay('interaction');
    } else if (!interactionPresenter.active && overlay === 'interaction') {
      setOverlay(overlayBeforeInteraction.current === 'interaction' ? 'none' : overlayBeforeInteraction.current);
    }
  }, [interactionPresenter.active, overlay, setOverlay]);

  useInput((input, key) => {
    if (key.ctrl && input === 's') {
      setOverlay('session-picker');
    } else if (key.ctrl && input === 'p') {
      setOverlay('settings');
    }
  });

  const showInteraction = interactionPresenter.active !== null;
  const showSettings = !showInteraction && overlay === 'settings';
  const showPicker = !showInteraction && !showSettings && (overlay === 'session-picker' || !currentSessionId);
  const footerHelp = showSettings
    ? t('cli.tui.footer.settings')
    : showPicker
      ? t('cli.tui.footer.picker')
      : t('cli.tui.footer.chat');

  return (
    <Box
      backgroundColor={TUI_THEME.surface}
      flexDirection="column"
      height="100%"
      paddingX={1}
      paddingY={1}
    >
      <Box
        borderColor={TUI_THEME.frame}
        borderStyle="single"
        flexDirection="column"
        paddingX={1}
      >
        <Box>
          <Text color={TUI_THEME.dim}>{t('cli.tui.sessionLabel')}</Text>
        </Box>
        <Box>
          <Text
            bold
            color={TUI_THEME.glow}
          >
            {TUI_GLYPHS.title}
          </Text>
        </Box>
        <Box>
          <Text color={TUI_THEME.accent}>{`${TUI_GLYPHS.caret} session `}</Text>
          {currentSession ? (
            <>
              <Text color={TUI_THEME.glow}>{currentSession.title}</Text>
              <Text color={TUI_THEME.dim}>
                {'  '}
                {currentSession.id}
              </Text>
            </>
          ) : (
            <Text color={TUI_THEME.dim}>{t('cli.tui.noneSelected')}</Text>
          )}
        </Box>
        <Text color={TUI_THEME.dim}>{'daemon://active'}</Text>
        <Text color={TUI_THEME.dim}>{t('cli.tui.headerHelp')}</Text>
      </Box>

      <Box
        borderColor={TUI_THEME.frame}
        borderStyle="single"
        flexDirection="column"
        flexGrow={1}
      >
        {showInteraction ? (
          <HostInteractionPrompt presenter={interactionPresenter} />
        ) : showSettings ? (
          <ModelSettings />
        ) : showPicker ? (
          <SessionPicker />
        ) : (
          <Transcript />
        )}
      </Box>

      {!showInteraction && !showSettings && !showPicker && currentSessionId && (
        <Composer sessionId={currentSessionId} />
      )}

      <Box
        borderColor={TUI_THEME.frame}
        borderStyle="single"
        paddingX={1}
      >
        <Text color={TUI_THEME.dim}>{footerHelp}</Text>
      </Box>
    </Box>
  );
}
