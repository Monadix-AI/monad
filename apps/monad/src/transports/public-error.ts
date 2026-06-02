import {
  type HttpError,
  newId,
  type PublicErrorDescriptor,
  publicErrorCodeSchema,
  publicErrorDescriptorSchema,
  type RequestCorrelationId
} from '@monad/protocol';

import { HANDLER_ERROR_MAP, HandlerError } from '#/handlers/handler-error.ts';
import { HostInteractionError, type HostInteractionErrorCode } from '#/interactions/service.ts';
import { EventCursorError } from '#/services/event-cursor.ts';

const MAX_MESSAGE_LENGTH = 2_048;
const requestCorrelationIds = new WeakMap<Request, RequestCorrelationId>();
const PUBLIC_HANDLER_ERRORS = {
  agent_credential_environment_variable_conflict: {
    code: 'AGENT_CREDENTIAL_ENVIRONMENT_VARIABLE_CONFLICT',
    detailKey: 'environmentVariable'
  },
  agent_credential_not_found: {
    code: 'AGENT_CREDENTIAL_NOT_FOUND',
    detailKey: 'credentialId'
  }
} as const;

const HOST_INTERACTION_ERRORS: Record<HostInteractionErrorCode, { status: number; code: string; retryable: boolean }> =
  {
    not_found: { status: 404, code: 'NOT_FOUND', retryable: false },
    source_limit: { status: 429, code: 'RATE_LIMITED', retryable: true },
    presenter_not_preferred: { status: 409, code: 'CONFLICT', retryable: false },
    incompatible_presenter: { status: 409, code: 'CONFLICT', retryable: false },
    already_claimed: { status: 409, code: 'CONFLICT', retryable: false },
    invalid_lease: { status: 403, code: 'FORBIDDEN', retryable: false },
    invalid_submission: { status: 400, code: 'VALIDATION', retryable: false },
    unsafe_pattern: { status: 409, code: 'CONFLICT', retryable: false },
    id_collision: { status: 409, code: 'CONFLICT', retryable: false }
  };

export interface MappedPublicError {
  status: number;
  descriptor: PublicErrorDescriptor;
}

export function createRequestCorrelationId(): RequestCorrelationId {
  return newId('req');
}

export function getRequestCorrelationId(request: Request): RequestCorrelationId {
  const existing = requestCorrelationIds.get(request);
  if (existing) return existing;
  const requestId = createRequestCorrelationId();
  requestCorrelationIds.set(request, requestId);
  return requestId;
}

export function consumeRequestCorrelationId(request: Request): RequestCorrelationId {
  const requestId = getRequestCorrelationId(request);
  requestCorrelationIds.delete(request);
  return requestId;
}

function boundedMessage(message: string): string {
  const normalized = message.trim();
  if (!normalized) return 'request failed';
  if (normalized.length <= MAX_MESSAGE_LENGTH) return normalized;
  return normalized.slice(0, MAX_MESSAGE_LENGTH);
}

function descriptor(
  requestId: RequestCorrelationId,
  code: string,
  message: string,
  retryable: boolean,
  details?: PublicErrorDescriptor['details']
): PublicErrorDescriptor {
  return publicErrorDescriptorSchema.parse({
    code,
    message: boundedMessage(message),
    retryable,
    requestId,
    ...(details ? { details } : {})
  });
}

function mapStructuredHandlerError(
  error: HandlerError,
  requestId: RequestCorrelationId
): MappedPublicError | undefined {
  if (!error.code || !(error.code in PUBLIC_HANDLER_ERRORS)) return undefined;
  const mapping = PUBLIC_HANDLER_ERRORS[error.code as keyof typeof PUBLIC_HANDLER_ERRORS];
  const value = error.params?.[mapping.detailKey];
  return {
    status: HANDLER_ERROR_MAP[error.kind].httpStatus,
    descriptor: descriptor(
      requestId,
      mapping.code,
      error.message,
      false,
      value === undefined ? undefined : { [mapping.detailKey]: value }
    )
  };
}

export function mapPublicError(
  error: unknown,
  requestId: RequestCorrelationId,
  transportCode?: string
): MappedPublicError {
  if (error instanceof EventCursorError) {
    return {
      status: HANDLER_ERROR_MAP[error.kind].httpStatus,
      descriptor: descriptor(requestId, error.code ?? 'CURSOR_INVALID', error.message, false)
    };
  }
  if (error instanceof HandlerError) {
    const structured = mapStructuredHandlerError(error, requestId);
    if (structured) return structured;
    const mapping = HANDLER_ERROR_MAP[error.kind];
    if (error.kind === 'invalid') {
      return {
        status: mapping.httpStatus,
        descriptor: descriptor(requestId, mapping.httpCode, 'request validation failed', false, {
          issues: ['request validation failed']
        })
      };
    }
    if (error.kind === 'internal') {
      return {
        status: mapping.httpStatus,
        descriptor: descriptor(requestId, mapping.httpCode, 'internal server error', false)
      };
    }
    if (error.kind === 'bad_gateway') {
      return {
        status: mapping.httpStatus,
        descriptor: descriptor(requestId, mapping.httpCode, 'upstream service unavailable', true)
      };
    }
    const parsedCode = publicErrorCodeSchema.safeParse(error.code);
    const publicCode = parsedCode.success ? parsedCode.data : mapping.httpCode;
    return {
      status: mapping.httpStatus,
      descriptor: descriptor(requestId, publicCode, error.message, false)
    };
  }

  if (error instanceof HostInteractionError) {
    const mapping = HOST_INTERACTION_ERRORS[error.code];
    return {
      status: mapping.status,
      descriptor: descriptor(requestId, mapping.code, error.message, mapping.retryable)
    };
  }

  if (transportCode === 'NOT_FOUND') {
    return {
      status: 404,
      descriptor: descriptor(requestId, 'NOT_FOUND', 'not found', false)
    };
  }

  if (transportCode === 'VALIDATION' || transportCode === 'PARSE') {
    return {
      status: 400,
      descriptor: descriptor(requestId, 'VALIDATION', 'request validation failed', false, {
        issues: ['request validation failed']
      })
    };
  }

  return {
    status: 500,
    descriptor: descriptor(requestId, 'INTERNAL', 'internal server error', false)
  };
}

export function projectHttpError(error: PublicErrorDescriptor): HttpError {
  return {
    error: error.message,
    code: error.code,
    retryable: error.retryable,
    requestId: error.requestId,
    ...(error.details ? { details: error.details } : {})
  };
}

export function mapDirectPublicError(
  request: Request,
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  details?: PublicErrorDescriptor['details']
): MappedPublicError {
  return {
    status,
    descriptor: descriptor(getRequestCorrelationId(request), code, message, retryable, details)
  };
}

export function projectHttpErrorResponse(
  mapped: MappedPublicError,
  headers?: Headers | Record<string, string>
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'application/json');
  responseHeaders.set('x-monad-request-id', mapped.descriptor.requestId);
  return new Response(JSON.stringify(projectHttpError(mapped.descriptor)), {
    status: mapped.status,
    headers: responseHeaders
  });
}

export function projectDirectHttpErrorResponse(
  request: Request,
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  details?: PublicErrorDescriptor['details'],
  headers?: Headers | Record<string, string>
): Response {
  return projectHttpErrorResponse(mapDirectPublicError(request, status, code, message, retryable, details), headers);
}
