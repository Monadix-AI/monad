import { expect, test } from 'bun:test';

import {
  initialProviderDialogStep,
  providerDialogCanGoBack,
  providerDialogNextStep,
  providerDialogPreviousStep
} from '../../components/studio/ModelSettings/provider-dialog-flow';

test('add provider starts at provider selection and can go back from configure', () => {
  const initial = initialProviderDialogStep('add');

  expect(initial).toBe('select');
  expect(providerDialogNextStep('add', initial)).toBe('configure');
  expect(providerDialogCanGoBack('add', 'configure')).toBe(true);
  expect(providerDialogPreviousStep('add', 'configure')).toBe('select');
});

test('edit provider reuses configure step without back navigation', () => {
  const initial = initialProviderDialogStep('edit');

  expect(initial).toBe('configure');
  expect(providerDialogCanGoBack('edit', 'configure')).toBe(false);
  expect(providerDialogPreviousStep('edit', 'configure')).toBe('configure');
});
