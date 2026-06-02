export type ProviderDialogMode = 'add' | 'edit';
export type ProviderDialogStep = 'select' | 'configure';

export function providerDialogSections(
  mode: ProviderDialogMode,
  step: ProviderDialogStep,
  needsUrl: boolean
): {
  showProviderPicker: boolean;
  showBaseUrl: boolean;
} {
  const isConfigure = mode === 'edit' || step === 'configure';
  return {
    showProviderPicker: mode === 'add' && step === 'select',
    showBaseUrl: mode === 'add' && isConfigure && needsUrl
  };
}

export function initialProviderDialogStep(mode: ProviderDialogMode): ProviderDialogStep {
  return mode === 'add' ? 'select' : 'configure';
}

export function providerDialogNextStep(mode: ProviderDialogMode, step: ProviderDialogStep): ProviderDialogStep {
  if (mode === 'add' && step === 'select') return 'configure';
  return step;
}

export function providerDialogCanGoBack(mode: ProviderDialogMode, step: ProviderDialogStep): boolean {
  return mode === 'add' && step === 'configure';
}

export function providerDialogPreviousStep(mode: ProviderDialogMode, step: ProviderDialogStep): ProviderDialogStep {
  return providerDialogCanGoBack(mode, step) ? 'select' : step;
}
