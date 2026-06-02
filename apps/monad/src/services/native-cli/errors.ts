export type NativeCliErrorCode =
  | 'provider_not_installed'
  | 'provider_not_logged_in'
  | 'unsupported_capability'
  | 'provider_timeout'
  | 'provider_protocol_error';

export class NativeCliError extends Error {
  constructor(
    readonly code: NativeCliErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'NativeCliError';
  }
}
