import type { SessionId } from '@monad/protocol';
import type { AppDispatch } from '../store/index.ts';

import { monadApi } from '@monad/client-rtk';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useDispatch } from 'react-redux';

import { t } from '../lib/i18n.ts';
import { addUserMessage } from '../store/server.ts';
import { useUIStore } from '../store/ui.ts';
import { TUI_GLYPHS, TUI_THEME } from './theme.ts';

interface Props {
  sessionId: SessionId;
}

export function Composer({ sessionId }: Props) {
  const dispatch = useDispatch<AppDispatch>();
  const input = useUIStore((s) => s.input);
  const setInput = useUIStore((s) => s.setInput);
  const isConnected = useUIStore((s) => s.isConnected);

  function onSubmit(value: string) {
    const text = value.trim();
    if (!text) return;
    setInput('');
    dispatch(addUserMessage(text));
    dispatch(monadApi.endpoints.sendMessage.initiate({ sessionId, text }))
      .unwrap()
      .catch(() => {});
  }

  return (
    <Box
      borderColor={TUI_THEME.frame}
      borderStyle="single"
      paddingX={1}
      paddingY={0}
    >
      <Text color={isConnected ? TUI_THEME.glow : TUI_THEME.danger}>{TUI_GLYPHS.caret} </Text>
      <TextInput
        onChange={setInput}
        onSubmit={onSubmit}
        placeholder={t('cli.tui.composerPlaceholder')}
        value={input}
      />
      <Text color={TUI_THEME.dim}>{`  ${t('cli.tui.composerHint')}`}</Text>
    </Box>
  );
}
