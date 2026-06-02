import type { PublicErrorDescriptor } from '@monad/protocol';

import { newId, publicErrorDescriptorSchema } from '@monad/protocol';

import { extractError } from '#/agent/loop/extract-error.ts';

export interface ProjectAgentErrorOptions {
  messageId?: string;
  agentName?: string;
}

// The canonical error descriptor carries the wire-safe code/message/retryable/requestId; the
// options carry the (optional) message/agent it is attached to. main's message plane no longer
// has a dedicated agent-error event payload schema — the descriptor IS the contract.
export type ProjectedAgentErrorPayload = PublicErrorDescriptor & ProjectAgentErrorOptions;

type AgentErrorClassification = Pick<PublicErrorDescriptor, 'code' | 'message' | 'retryable'>;

function unwrapAgentError(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof AggregateError; depth++) {
    const nested = current.errors[0];
    if (nested === undefined || nested === current) break;
    current = nested;
  }
  return current;
}

function signalValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function classifyAgentError(error: unknown): AgentErrorClassification {
  const leaf = unwrapAgentError(error);
  const extracted = extractError(error);
  const record =
    typeof leaf === 'object' && leaf !== null
      ? (leaf as { name?: unknown; status?: unknown; statusCode?: unknown; code?: unknown })
      : undefined;
  const signals = [
    signalValue(record?.name),
    signalValue(record?.status),
    signalValue(record?.statusCode),
    signalValue(record?.code),
    extracted.code ?? '',
    extracted.message
  ]
    .join(' ')
    .toUpperCase();
  const numericCodes = [record?.status, record?.statusCode, record?.code, extracted.code]
    .map((value) => Number(value))
    .filter(Number.isFinite);
  const hasNumericCode = (code: number): boolean => numericCodes.includes(code);

  if (/\bABORT(?:ED|ERROR)?\b|\bCANCEL(?:LED|ED|ATION)?\b/.test(signals)) {
    return { code: 'CANCELLED', message: 'generation cancelled', retryable: false };
  }
  if (hasNumericCode(429) || /\b429\b|RATE[_ -]?LIMIT|TOO MANY REQUESTS|RESOURCE[_ -]?EXHAUSTED/.test(signals)) {
    return { code: 'RATE_LIMITED', message: 'rate limit exceeded', retryable: true };
  }
  if (hasNumericCode(403) || /FORBIDDEN|AUTHORIZATION|PERMISSION[_ -]?DENIED|ACCESS[_ -]?DENIED/.test(signals)) {
    return { code: 'FORBIDDEN', message: 'request forbidden', retryable: false };
  }
  if (
    hasNumericCode(401) ||
    /UNAUTHORIZED|UNAUTHENTICATED|AUTHENTICATION|API[_ -]?KEY|INVALID[_ -]?CREDENTIAL/.test(signals)
  ) {
    return { code: 'UNAUTHORIZED', message: 'authentication failed', retryable: false };
  }
  if (
    numericCodes.some((code) => code >= 500 && code <= 599) ||
    /OVERLOAD|UNAVAILABLE|TIMEOUT|TIMED OUT|NETWORK|CONNECTION|ECONN|ETIMEDOUT/.test(signals)
  ) {
    return { code: 'BAD_GATEWAY', message: 'upstream service unavailable', retryable: true };
  }
  return { code: 'AGENT_ERROR', message: 'generation failed', retryable: false };
}

export function projectAgentError(error: unknown, options: ProjectAgentErrorOptions = {}): ProjectedAgentErrorPayload {
  const descriptor = publicErrorDescriptorSchema.parse({
    ...classifyAgentError(error),
    requestId: newId('req')
  });
  return { ...options, ...descriptor };
}
