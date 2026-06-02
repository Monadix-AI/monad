import { httpErrorSchema } from '@monad/protocol';
import { z } from 'zod';

const shape = httpErrorSchema.shape;

/** Take one field only if it validates on its own. */
function field<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A failed daemon call, carrying the daemon's own error descriptor rather than just an HTTP status.
 *
 * The daemon answers errors with `httpErrorSchema` — a stable `code`, a `requestId` that matches its
 * logs, and a `retryable` hint. Collapsing all of that into `request failed: 503` is what forced the
 * old exit-code classifier to guess by regex-matching an error string, which is why the same
 * unreachable daemon exited 4 from `status` and 1 from every other command.
 */
export class DaemonError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly retryable?: boolean;
  readonly details?: unknown;

  constructor(status: number, body: unknown) {
    // Field-by-field rather than one all-or-nothing parse: this is the consuming end of a boundary,
    // and one malformed optional field must not cost us the human-readable message next to it.
    const record = (body ?? {}) as Record<string, unknown>;
    const message = field(shape.error, record.error);
    super(message || `request failed: ${status}`);
    this.name = 'DaemonError';
    this.status = status;
    this.code = field(shape.code, record.code);
    this.requestId = field(shape.requestId, record.requestId);
    this.retryable = field(shape.retryable, record.retryable);
    this.details = field(shape.details, record.details);
  }

  /** Extra fields merged into the `--json` error frame so a pipeline can branch on them. */
  toJSON(): Record<string, unknown> {
    return {
      error: this.message,
      status: this.status,
      ...(this.code ? { code: this.code } : {}),
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.retryable === undefined ? {} : { retryable: this.retryable }),
      ...(this.details === undefined ? {} : { details: this.details })
    };
  }
}
