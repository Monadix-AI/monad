import { PROVIDER_CONFIG_ERROR_CODE, type ProviderConfigError } from '../model/gateway/gateway-routing.ts';

function isProviderConfigError(err: unknown): err is ProviderConfigError {
  return err instanceof Error && (err as Partial<ProviderConfigError>).code === PROVIDER_CONFIG_ERROR_CODE;
}

/**
 * Extract a user-facing { code, message, providerId? } from an API call error. Handles the
 * structured response-body formats of the mainstream AI providers; falls back to
 * the SDK-formatted err.message for everything else (long-tail providers, network
 * failures, etc.).
 */
export function extractError(err: unknown): { code?: string; message: string; providerId?: string } {
  // Unwrap gateway aggregate: all provider attempts failed. If every attempt failed before ever
  // reaching a provider (missing credentials / unsupported capability), surface that as one
  // provider-config signal rather than losing it behind whichever attempt happened to be first —
  // otherwise use the first sub-error, which is the most actionable single failure.
  if (err instanceof AggregateError) {
    if (err.errors.length > 0 && err.errors.every(isProviderConfigError)) {
      const first = err.errors[0] as ProviderConfigError;
      return { code: PROVIDER_CONFIG_ERROR_CODE, message: first.message, providerId: first.providerId };
    }
    const sub = err.errors[0];
    return sub !== undefined ? extractError(sub) : { message: err.message };
  }
  if (!(err instanceof Error)) return { message: String(err) };

  if (isProviderConfigError(err)) return { code: err.code, message: err.message, providerId: err.providerId };

  const e = err as Error & { statusCode?: unknown; code?: unknown; data?: unknown };
  const statusCode =
    typeof e.statusCode === 'number' || typeof e.statusCode === 'string' ? String(e.statusCode) : undefined;
  const errorCode = typeof e.code === 'number' || typeof e.code === 'string' ? String(e.code) : undefined;
  const httpCode = statusCode ?? errorCode;
  const data = e.data;

  if (data !== null && data !== undefined && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const rawErr = d.error;

    if (typeof rawErr === 'object' && rawErr !== null) {
      const apiErr = rawErr as Record<string, unknown>;

      // OpenRouter: metadata.raw is the upstream provider's actual error text.
      const meta = apiErr.metadata as Record<string, unknown> | undefined;
      if (typeof meta?.raw === 'string') {
        const prefix = typeof meta.provider_name === 'string' ? `[${meta.provider_name}] ` : '';
        return { code: httpCode, message: `${prefix}${meta.raw}` };
      }

      // Anthropic: { type: "error", error: { type, message } }
      if (d.type === 'error' && typeof apiErr.message === 'string') {
        const errType = typeof apiErr.type === 'string' ? apiErr.type : undefined;
        return { code: errType ?? httpCode, message: apiErr.message };
      }

      // Google: error.code is a number, error.status is a string enum.
      if (typeof apiErr.code === 'number' && typeof apiErr.message === 'string') {
        const status = typeof apiErr.status === 'string' ? apiErr.status : undefined;
        return { code: status ?? httpCode, message: apiErr.message };
      }

      // OpenAI / OpenAI-compatible / other: error.message with semantic code.
      if (typeof apiErr.message === 'string') {
        const semantic =
          typeof apiErr.code === 'string' ? apiErr.code : typeof apiErr.type === 'string' ? apiErr.type : undefined;
        return { code: semantic ?? httpCode, message: apiErr.message };
      }
    }
  }

  // Long-tail providers or network errors: fall back to the SDK-formatted message.
  return { code: httpCode, message: e.message };
}
