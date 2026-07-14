import type { Message } from '../store/server.ts';

import { Box, Text } from 'ink';

import { t } from '../lib/i18n.ts';
import { MESSAGE_SPEAKER_WIDTH } from './message-layout.ts';
import { TUI_GLYPHS, TUI_THEME } from './theme.ts';

export function MessageRow({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  const speaker = isUser ? t('cli.tui.speaker.operator') : t('cli.tui.speaker.monad');
  return (
    <Box
      flexDirection="column"
      marginBottom={1}
    >
      <Box>
        <Box
          flexShrink={0}
          width={MESSAGE_SPEAKER_WIDTH}
        >
          <Text
            bold
            color={isUser ? TUI_THEME.accent : TUI_THEME.glow}
          >
            {speaker}
          </Text>
          <Text color={TUI_THEME.dim}>
            {'  '}
            {TUI_GLYPHS.caret}{' '}
          </Text>
        </Box>
        <Box
          flexBasis={0}
          flexGrow={1}
          flexShrink={1}
        >
          <Text
            color={TUI_THEME.ink}
            wrap="wrap"
          >
            {message.content}
          </Text>
        </Box>
      </Box>
      {message.toolCalls.map((tc) => (
        <Box
          key={tc.id}
          paddingLeft={MESSAGE_SPEAKER_WIDTH}
        >
          <Text color={TUI_THEME.warning}>{`tool:${tc.name}`}</Text>
          <Text color={tc.failed ? TUI_THEME.danger : TUI_THEME.dim}>
            {tc.failed ? t('cli.tui.tool.failed') : t('cli.tui.tool.ok')}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
