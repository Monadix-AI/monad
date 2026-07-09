import type { WebMessageIdWithoutParams } from '@monad/i18n/browser';
import type { ModelModalities } from '@monad/protocol';

export function roleFallbackLabelKey(
  defaultModelCaps: ModelModalities | undefined,
  match: (c?: ModelModalities) => boolean
): WebMessageIdWithoutParams {
  return defaultModelCaps !== undefined && match(defaultModelCaps)
    ? 'web.model.useDefaultModel'
    : 'web.model.roleNotAvailable';
}
