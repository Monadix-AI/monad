import type { RootState } from '../store/index.ts';

import { Box, Text } from 'ink';
import { useSelector } from 'react-redux';

import { t } from '../lib/i18n.ts';
import { MessageRow } from './Message.tsx';
import { StreamingRow } from './Streaming.tsx';
import { TUI_THEME } from './theme.ts';

const MAX_VISIBLE = 50;

export function Transcript() {
  const currentSessionId = useSelector((s: RootState) => s.server.currentSessionId);
  const messages = useSelector((s: RootState) =>
    currentSessionId ? (s.server.transcripts[currentSessionId] ?? []) : []
  );
  const visible = messages.slice(-MAX_VISIBLE);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      paddingX={1}
      paddingY={1}
    >
      {visible.length === 0 && (
        <Box paddingY={1}>
          <Text color={TUI_THEME.dim}>{t('cli.tui.emptyTranscript')}</Text>
        </Box>
      )}
      {visible.map((msg) => (
        <MessageRow
          key={msg.id}
          message={msg}
        />
      ))}
      <StreamingRow />
    </Box>
  );
}
