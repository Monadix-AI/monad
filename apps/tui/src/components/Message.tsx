import type { Message } from '../store/server.ts';

import { Box, Text } from 'ink';

import { TUI_GLYPHS, TUI_THEME } from './theme.ts';

export function MessageRow({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  const speaker = isUser ? 'operator' : 'monad';
  return (
    <Box
      flexDirection="column"
      marginBottom={1}
    >
      <Box>
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
        <Text
          color={TUI_THEME.ink}
          wrap="wrap"
        >
          {message.content}
        </Text>
      </Box>
      {message.toolCalls.map((tc) => (
        <Box
          key={tc.id}
          paddingLeft={11}
        >
          <Text color={TUI_THEME.warning}>{`tool:${tc.name}`}</Text>
          <Text color={tc.failed ? TUI_THEME.danger : TUI_THEME.dim}>{tc.failed ? ' [fail]' : ' [ok]'}</Text>
        </Box>
      ))}
    </Box>
  );
}
