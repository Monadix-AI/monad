import { expect, mock, test } from 'bun:test';

import { deferredEffortCommit } from '../../src/components/ReasoningEffortControl.tsx';
import { composerReasoningEffortOptions } from '../../src/features/session/ComposerShell.tsx';

test('composer effort control can restore the profile or model default on close', () => {
  const onEffortChange = mock((_effort?: string) => {});
  const options = composerReasoningEffortOptions(['low', 'medium', 'high'], 'Default');

  expect(options.map((option) => option.value)).toEqual([undefined, 'low', 'medium', 'high']);
  const commit = deferredEffortCommit(false, 'high', options[0]?.value);
  if (commit) onEffortChange(commit.value);
  expect(onEffortChange).toHaveBeenCalledWith(undefined);
});
