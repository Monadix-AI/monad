import type { WebMessageIdWithoutParams } from '@monad/i18n/browser';

/**
 * How the host failed to put an experience on screen, and what the operator can do about it.
 *
 * The categories are structural — they describe what the host could not do, never what a
 * third-party backend's own business logic reported; an experience's API errors stay inside its own
 * contract. `retryable` marks the steps a retry can actually change: a definition the host cannot
 * read, or a module the browser refused, fails identically every time, so offering `Try again`
 * there would be noise.
 */
export const WORKPLACE_EXPERIENCE_FAILURES = {
  /** The host refused to activate it (for example a cross-origin module). */
  activation: { message: 'web.workplace.experienceFailure.activation', retryable: false },
  /** Its module or asset could not be fetched. */
  availability: { message: 'web.workplace.experienceFailure.availability', retryable: true },
  /** The module loaded but did not provide the component it declared. */
  'component-load': { message: 'web.workplace.experienceFailure.componentLoad', retryable: true },
  /** The definition cannot be rendered as written (bad custom-element name, unknown built-in). */
  'invalid-definition': { message: 'web.workplace.experienceFailure.invalidDefinition', retryable: false },
  /** The mounted component threw while rendering. */
  render: { message: 'web.workplace.experienceFailure.render', retryable: true }
} as const satisfies Record<string, { message: WebMessageIdWithoutParams; retryable: boolean }>;

type WorkplaceExperienceFailureCategory = keyof typeof WORKPLACE_EXPERIENCE_FAILURES;

export interface WorkplaceExperienceFailure {
  category: WorkplaceExperienceFailureCategory;
  /** Developer-facing specifics. Shown behind a disclosure, never as the primary message. */
  detail?: string;
}
