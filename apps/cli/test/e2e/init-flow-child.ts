import { addProviderInteractive } from '../../src/lib/init-flow.ts';

function ok<T>(data: T) {
  return { data, status: 200 };
}

const scenario = process.argv[2] ?? 'retry';
const calls: string[] = [];
const providers = Object.assign(
  ({ id }: { id: string }) => ({
    put: async (body: unknown) => {
      calls.push(`save:${id}:${JSON.stringify(body)}`);
      return ok({});
    },
    credentials: {
      post: async () => ok({})
    }
  }),
  {
    catalog: {
      get: async () =>
        ok({
          providers: [
            { label: 'OpenAI', type: 'openai', needsUrl: false, keyOptional: false },
            { label: 'Anthropic', type: 'anthropic', needsUrl: false, keyOptional: false }
          ]
        })
    }
  }
);
const client = {
  treaty: {
    v1: {
      settings: {
        model: {
          providers,
          'test-connection': {
            post: async ({ provider, accessToken }: { provider: { type: string }; accessToken: string }) => {
              calls.push(`test:${provider.type}:${accessToken}`);
              return ok(accessToken === 'good-key' ? { ok: true } : { ok: false, error: 'invalid key' });
            }
          }
        }
      }
    }
  }
};

const result = await addProviderInteractive(client as never);
process.stdout.write(`\nRESULT:${JSON.stringify({ scenario, result, calls })}\n`);
