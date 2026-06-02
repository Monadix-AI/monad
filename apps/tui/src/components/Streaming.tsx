import type { RootState } from '../store/index.ts';

import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import { t } from '../lib/i18n.ts';
import { activityFrame } from '../shell/activity-model.ts';
import { TUI_THEME } from './theme.ts';

export function StreamingRow() {
  const streaming = useSelector((s: RootState) => s.server.streaming);
  const isStreaming = useSelector((s: RootState) => s.server.isStreaming);
  const pendingTools = useSelector((s: RootState) => s.server.pendingTools);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!isStreaming) {
      setTick(0);
      return;
    }
    const timer = setInterval(() => setTick((value) => value + 1), 90);
    return () => clearInterval(timer);
  }, [isStreaming]);

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
      {isStreaming && (
        <Box>
          <Text
            bold
            color={TUI_THEME.glow}
          >
            {'Monad'}
          </Text>
          <Text color={TUI_THEME.accent}>{`  ${activityFrame(tick)} `}</Text>
          <Text wrap="wrap">{streaming || t('cli.tui.running')}</Text>
        </Box>
      )}
    </Box>
  );
}
