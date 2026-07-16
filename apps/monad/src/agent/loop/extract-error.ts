/**
 * Extract a user-facing { code, message } from an API call error. Handles the
 * structured response-body formats of the mainstream AI providers; falls back to
 * the SDK-formatted err.message for everything else (long-tail providers, network
 * failures, etc.).
 */
export function extractError(err: unknown): { code?: string; message: string } {
  // Unwrap gateway aggregate: all provider attempts failed — use the first sub-error.
  if (err instanceof AggregateError) {
    const sub = err.errors[0];
    return sub !== undefined ? extractError(sub) : { message: err.message };
  }
  if (!(err instanceof Error)) return { message: String(err) };

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
