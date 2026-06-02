import { describe, expect, test } from 'bun:test';

import { createHttpTransport } from '../../../src/transports/http';
import { enrichOpenApiOperations } from '../../../src/transports/openapi';
import { buildHandlers, mockModel } from '../../../test/helpers';

describe('local Scalar OpenAPI metadata', () => {
  test('fills missing operation metadata while preserving authored values', () => {
    const document = {
      paths: {
        '/v1/sessions/{id}/messages': {
          get: {},
          post: {
            summary: 'Send a session message',
            description: 'Streams a new user message into the selected session.',
            tags: ['Sessions']
          }
        },
        '/v1/settings/models': { get: {} },
        '/v1/internal/native-agent/project/read': { post: {} }
      }
    };

    expect(enrichOpenApiOperations(document)).toEqual({
      paths: {
        '/v1/sessions/{id}/messages': {
          get: {
            summary: 'Get sessions messages',
            description: 'Get sessions messages. This operation is exposed by the local Monad daemon.',
            tags: ['Sessions']
          },
          post: {
            summary: 'Send a session message',
            description: 'Streams a new user message into the selected session.',
            tags: ['Sessions']
          }
        },
        '/v1/settings/models': {
          get: {
            summary: 'Get settings models',
            description: 'Get settings models. This operation is exposed by the local Monad daemon.',
            tags: ['Models settings']
          }
        },
        '/v1/internal/native-agent/project/read': {
          post: {
            summary: 'Run internal native agent project read',
            description: 'Run internal native agent project read. This operation is exposed by the local Monad daemon.',
            tags: ['Native agent internals']
          }
        }
      }
    });
  });

  test('serves complete metadata for every operation in the developer Scalar document', async () => {
    const app = createHttpTransport(buildHandlers(mockModel()), { docs: true });
    const response = await app.handle(new Request('http://localhost/docs/json'));
    const document = (await response.json()) as {
      paths: Record<string, Record<string, { summary?: string; description?: string; tags?: string[] }>>;
    };
    const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
    const operations = Object.values(document.paths).flatMap((path) =>
      Object.entries(path).filter(([method]) => methods.has(method))
    );

    expect(response.status).toBe(200);
    expect(operations.length).toBeGreaterThan(300);
    expect(
      operations.every(([, operation]) =>
        Boolean(operation.summary?.trim() && operation.description?.trim() && operation.tags?.length)
      )
    ).toBe(true);
  });
});
