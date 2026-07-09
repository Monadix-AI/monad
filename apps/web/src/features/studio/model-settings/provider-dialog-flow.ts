export type ProviderDialogMode = 'add' | 'edit';
export type ProviderDialogStep = 'select' | 'configure';

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
