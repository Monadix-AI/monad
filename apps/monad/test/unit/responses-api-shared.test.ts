import { expect, test } from 'bun:test';

import { HandlerError } from '#/handlers/handler-error.ts';
import { handlerErrorToResponse, internalErrorResponse } from '#/transports/http/responses-api/shared.ts';

test('Responses API internal failures never expose provider or handler details', async () => {
  const providerResponse = internalErrorResponse('model_error');
  const handlerResponse = handlerErrorToResponse(
    new HandlerError('internal', 'SQLITE_CONSTRAINT: sessions.token contains secret-value', 'storage_failure')
  );

  expect({
    providerStatus: providerResponse.status,
    providerBody: await providerResponse.json(),
    handlerStatus: handlerResponse.status,
    handlerBody: await handlerResponse.json()
  }).toEqual({
    providerStatus: 500,
    providerBody: {
      error: { message: 'An internal error occurred.', type: 'api_error', code: 'model_error' }
    },
    handlerStatus: 500,
    handlerBody: {
      error: { message: 'An internal error occurred.', type: 'api_error', code: 'storage_failure' }
    }
  });
});
