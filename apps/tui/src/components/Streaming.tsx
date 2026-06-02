import type { RootState } from '../store/index.ts';

import { Box, Text } from 'ink';
import { useSelector } from 'react-redux';

import { t } from '../lib/i18n.ts';
import { TUI_GLYPHS, TUI_THEME } from './theme.ts';

export function StreamingRow() {
  const streaming = useSelector((s: RootState) => s.server.streaming);
  const isStreaming = useSelector((s: RootState) => s.server.isStreaming);
  const pendingTools = useSelector((s: RootState) => s.server.pendingTools);

  if (!isStreaming && pendingTools.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      marginBottom={1}
    >
      {pendingTools
        .filter((t) => !t.done)
        .map((tc) => (
          <Box
            key={tc.id}
            paddingLeft={11}
          >
            <Text color={TUI_THEME.warning}>tool:{tc.name} </Text>
            <Text color={TUI_THEME.dim}>{t('cli.tui.running')}</Text>
          </Box>
        ))}
      {streaming && (
        <Box>
          <Text
            bold
            color={TUI_THEME.glow}
          >
            {'monad'}
          </Text>
          <Text color={TUI_THEME.dim}>
            {'  '}
            {TUI_GLYPHS.caret}{' '}
          </Text>
          <Text wrap="wrap">{streaming}</Text>
        </Box>
      )}
    </Box>
  );
}
