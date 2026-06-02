// Interaction error taxonomy, in its own module so both the service and the (import-free) validation
// helpers can throw it without a cycle. The public HTTP mapping lives in transports/public-error.ts.

export type HostInteractionErrorCode =
  | 'not_found'
  | 'source_limit'
  | 'presenter_not_preferred'
  | 'incompatible_presenter'
  | 'already_claimed'
  | 'invalid_lease'
  | 'invalid_submission'
  | 'unsafe_pattern'
  | 'id_collision';

export class HostInteractionError extends Error {
  constructor(
    readonly code: HostInteractionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'HostInteractionError';
  }
}
