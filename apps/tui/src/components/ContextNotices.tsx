import type { ContextNotice, MemorySuggestion } from '@monad/client-rtk';
import type { ContextUsagePayload } from '@monad/protocol';

import { useAddMemoryFactMutation } from '@monad/client-rtk';
import { memoryScopeQuerySchema } from '@monad/protocol';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import { t } from '../lib/i18n.ts';
import { latestHandoffNudge } from '../shell/context-notice-model.ts';
import { safeErrorMessage } from '../shell/view-model.ts';
import { TUI_GLYPHS, TUI_THEME } from './theme.ts';

export function ContextNudgeLine({
  notices,
  usage
}: {
  notices: readonly ContextNotice[] | undefined;
  usage: ContextUsagePayload | undefined;
}) {
  const nudge = latestHandoffNudge(notices, usage);
  if (!nudge) return null;
  return (
    <Box paddingX={1}>
      <Text color={TUI_THEME.warning}>
        {t('cli.tui.context.handoffNudge', { used: Math.round(nudge.usedFraction * 100) })}
      </Text>
    </Box>
  );
}

export function MemorySuggestionPrompt({
  suggestion,
  onResolve
}: {
  suggestion: MemorySuggestion;
  onResolve: (id: string, outcome: 'saved' | 'dismissed') => void;
}) {
  const [addMemoryFact] = useAddMemoryFactMutation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const scope = memoryScopeQuerySchema.parse({ scopeKind: suggestion.scope.kind, scopeId: suggestion.scope.id });
      await Promise.all(suggestion.facts.map((content) => addMemoryFact({ ...scope, content }).unwrap()));
      onResolve(suggestion.id, 'saved');
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  useInput((typed, key) => {
    if (saving) return;
    if (key.escape || typed.toLowerCase() === 'n') onResolve(suggestion.id, 'dismissed');
    else if (key.return || typed.toLowerCase() === 'y') void save();
  });

  return (
    <Box
      borderColor={TUI_THEME.accent}
      borderStyle="single"
      flexDirection="column"
      paddingX={1}
    >
      <Text
        bold
        color={TUI_THEME.glow}
      >
        {`${TUI_GLYPHS.caret} ${t('cli.tui.memory.suggestion', { count: suggestion.facts.length })}`}
      </Text>
      {suggestion.facts.map((fact, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: facts are plain strings that can repeat; the list never reorders
        <Text key={index}>{`  ${TUI_GLYPHS.branch} ${fact}`}</Text>
      ))}
      {error && <Text color={TUI_THEME.danger}>{error}</Text>}
      <Text color={TUI_THEME.dim}>{saving ? t('cli.tui.memory.saving') : t('cli.tui.memory.suggestionHint')}</Text>
    </Box>
  );
}
