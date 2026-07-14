import type { EditorState } from './editor-model.ts';

import { Box, Text } from 'ink';

import { t } from '../lib/i18n.ts';
import { TUI_THEME } from './theme.ts';

export function ShellComposer({
  active,
  busy,
  queued,
  state
}: {
  active: boolean;
  busy: boolean;
  queued: number;
  state: EditorState;
}) {
  const before = state.value.slice(0, state.cursor);
  const cursor = state.value[state.cursor] ?? ' ';
  const after = state.value.slice(state.cursor + (state.cursor < state.value.length ? 1 : 0));
  return (
    <Box
      borderColor={active ? TUI_THEME.accent : TUI_THEME.frame}
      borderStyle="single"
      flexDirection="column"
      minHeight={3}
      paddingX={1}
    >
      <Box>
        <Text color={active ? TUI_THEME.glow : TUI_THEME.dim}>{active ? '› ' : '  '}</Text>
        {state.value.length === 0 && !active ? (
          <Text color={TUI_THEME.dim}>{t('cli.tui.composer.focusHint')}</Text>
        ) : (
          <Text>
            {before}
            <Text inverse={active}>{cursor}</Text>
            {after}
          </Text>
        )}
      </Box>
      <Text color={TUI_THEME.dim}>
        {busy
          ? t('cli.tui.composer.busyHint', { queued: queued ? ` · ${queued} queued` : '' })
          : t('cli.tui.composer.idleHint')}
      </Text>
    </Box>
  );
}
