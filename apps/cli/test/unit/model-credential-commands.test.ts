import { expect, test } from 'bun:test';

import { command as credentialsCmd } from '../../src/commands/model/credentials.ts';
import { command as providersCmd } from '../../src/commands/model/providers.ts';
import { command as model } from '../../src/commands/model.ts';
import { CliError, type CommandContext } from '../../src/commands/types.ts';

function ctx(positionals: string[], flags: Record<string, unknown>, client: unknown): CommandContext {
  return {
    positionals,
    flags,
    globals: { json: false, quiet: false, verbose: 0, yes: false, color: false },
    client: client as CommandContext['client']
  };
}

async function silently(fn: () => Promise<void>): Promise<void> {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
}

function ok<T>(data: T) {
  return { data, status: 200 };
}

// ── model command routing ──────────────────────────────────────────────────────

test('model: routes to profiles for list action', async () => {
  let called = false;
  const client = {
    treaty: {
      v1: {
        settings: {
          model: {
            profiles: {
              get: async () => {
                called = true;
                return ok({ profiles: [] });
              }
            }
          }
        }
      }
    }
  };
  await silently(() => model.run(ctx(['list'], {}, client)));
  expect(called).toBe(true);
});

test('model: routes to profiles for set action', async () => {
  let called = false;
  const profile = {
    alias: 'gpt4',
    routes: { chat: { provider: 'openai', modelId: 'gpt-4' } },
    params: {},
    fallbacks: []
  };
  const client = {
    treaty: {
      v1: {
        settings: {
          model: {
            profiles: Object.assign(
              (_: unknown) => ({
                put: async () => {
                  called = true;
                  return ok({ profile });
                },
                delete: async () => ok({})
              }),
              { get: async () => ok({ profiles: [], defaultAlias: 'gpt4' }) }
            )
          }
        }
      }
    }
  };
  await silently(() => model.run(ctx(['set', JSON.stringify(profile)], {}, client)));
  expect(called).toBe(true);
});

test('model: throws on unknown action', async () => {
  const client = {};
  await expect(silently(() => model.run(ctx(['unknown'], {}, client)))).rejects.toBeInstanceOf(CliError);
});

// ── providers ──────────────────────────────────────────────────────────────────

test('providers list: prints empty when no providers', async () => {
  const client = {
    treaty: {
      v1: { settings: { model: { providers: { get: async () => ok({ providers: [] }) } } } }
    }
  };
  await silently(() => providersCmd.run(ctx([], {}, client)));
});

test('providers list: prints provider details', async () => {
  const providers = [{ id: 'openai', label: 'OpenAI', type: 'openai', baseUrl: null }];
  const client = {
    treaty: {
      v1: { settings: { model: { providers: { get: async () => ok({ providers }) } } } }
    }
  };
  await silently(() => providersCmd.run(ctx(['list'], {}, client)));
});

test('providers set: saves a provider', async () => {
  let savedProvider: unknown;
  const provider = {
    id: 'openai',
    label: 'OpenAI',
    type: 'openai'
  };
  const client = {
    treaty: {
      v1: {
        settings: {
          model: {
            providers: Object.assign(
              (args: { id: string }) => ({
                put: async (body: { provider: unknown }) => {
                  savedProvider = { id: args.id, ...body };
                  return ok({ provider });
                },
                delete: async () => ok({})
              }),
              { get: async () => ok({ providers: [] }) }
            )
          }
        }
      }
    }
  };
  await silently(() => providersCmd.run(ctx(['set', JSON.stringify(provider)], {}, client)));
  expect((savedProvider as { id: string }).id).toBe('openai');
});

test('providers set: throws usage error when arg is missing', async () => {
  const client = {
    treaty: {
      v1: { settings: { model: { providers: { get: async () => ok({ providers: [] }) } } } }
    }
  };
  await expect(silently(() => providersCmd.run(ctx(['set'], {}, client)))).rejects.toBeInstanceOf(CliError);
});

test('providers delete: removes a provider', async () => {
  let deletedId: string | undefined;
  const client = {
    treaty: {
      v1: {
        settings: {
          model: {
            providers: Object.assign(
              (args: { id: string }) => ({
                put: async () => ok({}),
                delete: async () => {
                  deletedId = args.id;
                  return ok({});
                }
              }),
              { get: async () => ok({ providers: [] }) }
            )
          }
        }
      }
    }
  };
  await silently(() => providersCmd.run(ctx(['remove', 'openai'], {}, client)));
  expect(deletedId).toBe('openai');
});

test('providers delete: throws usage error when id is missing', async () => {
  const client = {
    treaty: {
      v1: { settings: { model: { providers: { get: async () => ok({ providers: [] }) } } } }
    }
  };
  await expect(silently(() => providersCmd.run(ctx(['rm'], {}, client)))).rejects.toBeInstanceOf(CliError);
});

// ── credentials ────────────────────────────────────────────────────────────────

test('credential list: prints empty when no credentials', async () => {
  const client = {
    treaty: {
      v1: {
        settings: {
          model: {
            providers: (_: unknown) => ({
              credentials: { get: async () => ok({ credentials: [] }) }
            })
          }
        }
      }
    }
  };
  await silently(() => credentialsCmd.run(ctx(['list', 'openai'], {}, client)));
});

test('credential list: prints credentials with status', async () => {
  const credentials = [
    { id: 'cred_1', label: 'My Key', authType: 'token', accessTokenPreview: 'sk-...abc', lastStatus: 'ok' }
  ];
  const client = {
    treaty: {
      v1: {
        settings: {
          model: {
            providers: (_: unknown) => ({
              credentials: { get: async () => ok({ credentials }) }
            })
          }
        }
      }
    }
  };
  await silently(() => credentialsCmd.run(ctx(['list', 'openai'], {}, client)));
});

test('credential list: throws usage error when provider id is missing', async () => {
  const client = {
    treaty: {
      v1: {
        settings: {
          model: { providers: (_: unknown) => ({ credentials: { get: async () => ok({ credentials: [] }) } }) }
        }
      }
    }
  };
  await expect(silently(() => credentialsCmd.run(ctx([], {}, client)))).rejects.toBeInstanceOf(CliError);
});

test('credential add: adds a credential', async () => {
  let addedBody: unknown;
  const body = { label: 'My Key', authType: 'api_key', accessToken: 'sk-test-123' };
  const client = {
    treaty: {
      v1: {
        settings: {
          model: {
            providers: (_: unknown) => ({
              credentials: {
                get: async () => ok({ credentials: [] }),
                post: async (b: unknown) => {
                  addedBody = b;
                  return ok({ id: 'cred_new' });
                }
              }
            })
          }
        }
      }
    }
  };
  await silently(() => credentialsCmd.run(ctx(['add', 'openai', JSON.stringify(body)], {}, client)));
  expect((addedBody as { label: string }).label).toBe('My Key');
});

test('credential add: throws usage error when args are missing', async () => {
  const client = {
    treaty: {
      v1: {
        settings: { model: { providers: (_: unknown) => ({ credentials: { post: async () => ok({ id: 'x' }) } }) } }
      }
    }
  };
  await expect(silently(() => credentialsCmd.run(ctx(['add', 'openai'], {}, client)))).rejects.toBeInstanceOf(CliError);
  await expect(silently(() => credentialsCmd.run(ctx(['add'], {}, client)))).rejects.toBeInstanceOf(CliError);
});

test('credential delete: removes a credential', async () => {
  let deletedCredId: string | undefined;
  const client = {
    treaty: {
      v1: {
        settings: {
          model: {
            providers: (_: unknown) => ({
              credentials: Object.assign(
                (args: { credId: string }) => ({
                  delete: async () => {
                    deletedCredId = args.credId;
                    return ok({});
                  },
                  test: { post: async () => ok({ ok: true, latencyMs: 120 }) }
                }),
                { get: async () => ok({ credentials: [] }), post: async () => ok({ id: 'x' }) }
              )
            })
          }
        }
      }
    }
  };
  await silently(() => credentialsCmd.run(ctx(['delete', 'openai', 'cred_1'], {}, client)));
  expect(deletedCredId).toBe('cred_1');
});

test('credential test: reports ok with latency', async () => {
  const client = {
    treaty: {
      v1: {
        settings: {
          model: {
            providers: (_: unknown) => ({
              credentials: Object.assign(
                (_2: unknown) => ({
                  delete: async () => ok({}),
                  test: { post: async () => ok({ ok: true, latencyMs: 88, error: null }) }
                }),
                { get: async () => ok({ credentials: [] }), post: async () => ok({ id: 'x' }) }
              )
            })
          }
        }
      }
    }
  };
  await silently(() => credentialsCmd.run(ctx(['test', 'openai', 'cred_1'], {}, client)));
});

test('credential test: reports error on failed test', async () => {
  const client = {
    treaty: {
      v1: {
        settings: {
          model: {
            providers: (_: unknown) => ({
              credentials: Object.assign(
                (_2: unknown) => ({
                  delete: async () => ok({}),
                  test: { post: async () => ok({ ok: false, latencyMs: null, error: 'invalid key' }) }
                }),
                { get: async () => ok({ credentials: [] }), post: async () => ok({ id: 'x' }) }
              )
            })
          }
        }
      }
    }
  };
  await silently(() => credentialsCmd.run(ctx(['test', 'openai', 'cred_1'], {}, client)));
});

test('credential test: throws usage error when args are missing', async () => {
  function credTestClient() {
    const credFactory = Object.assign(
      (_2: unknown) => ({
        delete: async () => ok({}),
        test: { post: async () => ok({ ok: true, latencyMs: null, error: null }) }
      }),
      { get: async () => ok({ credentials: [] }), post: async () => ok({ id: 'x' }) }
    );
    return { treaty: { v1: { settings: { model: { providers: (_: unknown) => ({ credentials: credFactory }) } } } } };
  }
  await expect(
    silently(() => credentialsCmd.run(ctx(['test', 'openai'], {}, credTestClient())))
  ).rejects.toBeInstanceOf(CliError);
});
