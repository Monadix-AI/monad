import { expect, test } from 'bun:test';

import {
  initialProviderDialogStep,
  providerDialogCanGoBack,
  providerDialogNextStep,
  providerDialogPreviousStep,
  providerDialogSections
} from '../../src/features/studio/model-settings/provider-dialog-flow';

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

test('add provider keeps provider details in configure step', () => {
  expect(providerDialogSections('add', 'select', true)).toEqual({
    showProviderPicker: true,
    showBaseUrl: false
  });
  expect(providerDialogSections('add', 'configure', true)).toEqual({
    showProviderPicker: false,
    showBaseUrl: true
  });
  expect(providerDialogSections('add', 'configure', false)).toEqual({
    showProviderPicker: false,
    showBaseUrl: false
  });
});
