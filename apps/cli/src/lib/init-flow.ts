import type { MonadClient } from '@monad/client';
import type {
  CreateAgentResponse,
  GetProviderCatalogResponse,
  ListModelsResponse,
  ListProfilesResponse,
  ListProvidersResponse,
  TestConnectionResponse
} from '@monad/protocol';

import { createInterface, emitKeypressEvents } from 'node:readline';
import { getPaths, initMonadHome, isHomeInitialized, loadAll, openUrl, setMonadRoot } from '@monad/home';
import { KNOWN_PROVIDER_TYPES } from '@monad/protocol';

import { ensureBrowserBinary } from './browser-binary.ts';
import { startDaemon, stopDaemon } from './daemon.ts';
import { ensureEnvDeps } from './env-deps.ts';
import { ensureWindowsShell } from './git-bash.ts';
import { t } from './i18n.ts';
import { bold, cyan, dim, green, out, red, yellow } from './output.ts';
import { requireTreatyData } from './treaty.ts';

export function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

type InitFlowIO = {
  ask?: (question: string) => Promise<string>;
};

type SelectOption<T> = {
  label: string;
  value: T;
  detail?: string;
};

function askWith(io: InitFlowIO | undefined): (question: string) => Promise<string> {
  return io?.ask ?? ask;
}

async function selectOption<T>(
  question: string,
  options: SelectOption<T>[],
  io: InitFlowIO | undefined,
  fallbackPrompt: string
): Promise<T> {
  const prompt = askWith(io);
  const useArrowSelect = !io?.ask && process.stdin.isTTY && process.stdout.isTTY && options.length > 0;
  if (!useArrowSelect) {
    out(question);
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      if (option) out(`  ${cyan(String(i + 1))}. ${option.label}${option.detail ? dim(`  ${option.detail}`) : ''}`);
    }
    while (true) {
      const pick = await prompt(fallbackPrompt);
      const idx = parseInt(pick, 10) - 1;
      if (idx >= 0 && idx < options.length) {
        // biome-ignore lint/style/noNonNullAssertion: bounds checked above
        return options[idx]!.value;
      }
      out(yellow(t('init.numRange', { n: options.length })));
    }
  }

  let index = 0;
  const stdin = process.stdin;
  const stdout = process.stdout;
  const rawMode = typeof stdin.setRawMode === 'function' && stdin.isTTY;
  const render = () => {
    stdout.write(`\r\x1b[2K${question}\n`);
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      if (!option) continue;
      const marker = i === index ? cyan('›') : ' ';
      stdout.write(`\x1b[2K${marker} ${option.label}${option.detail ? dim(`  ${option.detail}`) : ''}\n`);
    }
    stdout.write(`\x1b[2K${dim(t('init.select.hint'))}\n`);
    stdout.write(`\x1b[${options.length + 2}A`);
  };

  return await new Promise<T>((resolve, reject) => {
    let digits = '';
    const cleanup = () => {
      stdin.off('keypress', onKeypress);
      if (rawMode) stdin.setRawMode(false);
      stdout.write(`\x1b[${options.length + 2}B`);
    };
    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('cancelled'));
        return;
      }
      if (key.name === 'up') {
        index = (index - 1 + options.length) % options.length;
        render();
        return;
      }
      if (key.name === 'down') {
        index = (index + 1) % options.length;
        render();
        return;
      }
      if (key.name === 'return') {
        cleanup();
        // biome-ignore lint/style/noNonNullAssertion: non-empty options checked above
        resolve(options[index]!.value);
        return;
      }
      if (/^[1-9]$/.test(key.sequence ?? '')) {
        digits += key.sequence;
        const idx = parseInt(digits, 10) - 1;
        if (idx >= 0 && idx < options.length) {
          index = idx;
          render();
        }
        return;
      }
      if (key.name === 'backspace') {
        digits = digits.slice(0, -1);
      }
    };
    emitKeypressEvents(stdin);
    if (rawMode) stdin.setRawMode(true);
    stdin.on('keypress', onKeypress);
    render();
  });
}

/** Check init status via HTTP if daemon is reachable, otherwise from disk. */
export async function checkInitialized(client: MonadClient): Promise<boolean> {
  try {
    const result = await client.treaty.v1.init.status.get();
    if (result.data) return result.data.initialized;
  } catch {
    // daemon not reachable — fall back to disk check
  }
  const status = await isHomeInitialized(getPaths());
  return status.initialized;
}

/**
 * Ensure daemon is running. Waits up to 5s for it to become reachable after spawn.
 */
async function ensureDaemonRunning(client: MonadClient): Promise<boolean> {
  try {
    await client.treaty.health.get();
    return true;
  } catch {
    /* unreachable — start it */
  }

  const { startDaemon: spawn } = await import('./daemon.ts');
  await spawn();

  for (let i = 0; i < 20; i++) {
    await Bun.sleep(300);
    try {
      await client.treaty.health.get();
      return true;
    } catch {
      /* not yet */
    }
  }
  out(red(t('init.daemonUnreachable')));
  return false;
}

/** Interactively collect provider details, test connection, and persist provider + credential. */
export async function addProviderInteractive(
  client: MonadClient,
  io?: InitFlowIO
): Promise<{ id: string; label: string } | null> {
  const prompt = askWith(io);
  // The provider catalog is assembled by the daemon from registered providers' descriptors
  // (first- and third-party), so the CLI never hardcodes the provider list.
  const catalog = requireTreatyData<GetProviderCatalogResponse>(
    await client.treaty.v1.settings.model.providers.catalog.get()
  ).providers;

  while (true) {
    const chosen = await selectOption(
      t('init.provider.choose'),
      catalog.map((entry) => ({
        label: entry.label,
        value: entry,
        detail: entry.defaultBaseUrl
      })),
      io,
      t('init.provider.select', { n: catalog.length })
    );
    const chosenType = chosen.type;

    while (true) {
      let baseUrl: string | undefined;
      if (chosen.needsUrl) {
        while (!baseUrl) {
          const u = await prompt(t('init.provider.baseUrl'));
          if (u) baseUrl = u;
          else out(yellow(t('init.provider.baseUrlRequired')));
        }
      }

      const extra: Record<string, string> = {};
      for (const f of chosen.extraFields ?? []) {
        let v: string | undefined;
        while (!v) {
          const ans = await prompt(`${f.label}${f.placeholder ? dim(` (e.g. ${f.placeholder})`) : ''}: `);
          if (ans) v = ans;
          else if (!f.required) break;
          else out(yellow(t('init.field.required', { label: f.label })));
        }
        if (v) extra[f.key] = v;
      }
      const hasExtra = Object.keys(extra).length > 0;

      const providerLabel = chosen.label;
      const providerId = `${chosenType}-${Date.now()}`;

      let apiKey: string | undefined;
      if (!chosen.keyOptional) {
        while (!apiKey) {
          const hint = chosen.keyPlaceholder ? dim(` (e.g. ${chosen.keyPlaceholder})`) : '';
          const k = await prompt(t('init.apiKey', { hint }));
          if (k) apiKey = k;
          else out(yellow(t('init.apiKeyRequired')));
        }
      } else {
        apiKey = (await prompt(t('init.apiKeyOptional'))) || '';
      }

      out(dim(t('init.testing')));
      const provider = {
        id: providerId,
        label: providerLabel,
        type: chosenType as (typeof KNOWN_PROVIDER_TYPES)[number],
        ...(baseUrl ? { baseUrl } : {}),
        ...(hasExtra ? { extra } : {})
      };
      const testResult = requireTreatyData<TestConnectionResponse>(
        await client.treaty.v1.settings.model['test-connection'].post({ provider, accessToken: apiKey ?? '' })
      );

      if (!testResult.ok) {
        out(red(t('init.connFailed', { error: testResult.error ?? 'unknown error' })));
        const action = await selectOption(
          t('init.provider.afterFailed'),
          [
            { label: t('init.provider.retry'), value: 'retry' as const },
            { label: t('init.provider.back'), value: 'back' as const }
          ],
          io,
          t('init.provider.afterFailedSelect')
        );
        if (action === 'back') break;
        continue;
      }
      out(green(t('init.connOk')));

      requireTreatyData(await client.treaty.v1.settings.model.providers({ id: provider.id }).put({ provider }));
      requireTreatyData(
        await client.treaty.v1.settings.model.providers({ id: providerId }).credentials.post({
          label: `${providerLabel} key`,
          authType: 'api_key',
          accessToken: apiKey ?? '',
          ...(baseUrl ? { baseUrl } : {})
        })
      );

      return { id: providerId, label: providerLabel };
    }
  }
}

export async function chooseDefaultModelInteractive(
  models: ListModelsResponse['models'],
  io?: InitFlowIO
): Promise<string | undefined> {
  const prompt = askWith(io);
  let defaultModelId: string | undefined;

  if (models.length > 0) {
    out(`\n${t('init.models.available')}`);
    for (let i = 0; i < Math.min(models.length, 15); i++) {
      const m = models[i];
      if (m) out(`  ${cyan(String(i + 1))}. ${m.id}${m.label ? dim(` — ${m.label}`) : ''}`);
    }
    if (models.length > 15) out(dim(t('init.models.more', { n: models.length - 15 })));

    defaultModelId = models[0]?.id;
    const pick = await prompt(`\n${t('init.model.default', { model: bold(defaultModelId ?? '') })}`);
    const idx = parseInt(pick, 10) - 1;
    if (idx >= 0 && idx < models.length) {
      defaultModelId = models[idx]?.id;
    } else if (pick) {
      defaultModelId = pick;
    }
  } else {
    while (!defaultModelId) {
      const id = await prompt(t('init.model.idPrompt'));
      if (id) defaultModelId = id;
      else out(yellow(t('init.model.idRequired')));
    }
  }

  return defaultModelId;
}

/** Interactive terminal init wizard. */
export async function runTerminalInit(client: MonadClient): Promise<boolean> {
  out('');
  out(bold(t('init.title')));
  out(dim('─────────────────────────────────'));

  ensureWindowsShell();

  const currentHome = getPaths().home;
  out(`\n${bold(t('init.step1'))}`);
  out(dim(t('init.home.current', { home: currentHome })));
  const homeAnswer = await ask(t('init.home.prompt', { enter: bold('Enter') }));

  if (homeAnswer && homeAnswer !== currentHome) {
    out(dim(t('init.home.setting', { path: homeAnswer })));
    await setMonadRoot(homeAnswer);
    await initMonadHome(getPaths());

    const daemonWasRunning = await ensureDaemonRunning(client).catch(() => false);
    if (daemonWasRunning) {
      out(dim(t('init.home.restarting')));
      await stopDaemon();
      await startDaemon();
      for (let i = 0; i < 20; i++) {
        await Bun.sleep(300);
        try {
          await client.treaty.health.get();
          break;
        } catch {
          /* wait */
        }
      }
    }
  } else {
    await initMonadHome(getPaths());
  }

  out(`\n${bold(t('init.step2'))}`);

  const ready = await ensureDaemonRunning(client);
  if (!ready) return false;

  // Check for runtime tools (node/uv) needed by MCP servers — install via daemon if missing.
  await ensureEnvDeps(ask, client);

  // Offer to install a Playwright browser if the preset is enabled — without it
  // the browser tools fail cryptically on first use.
  const p = getPaths();
  const cfg = await loadAll(p.config, p.profile);
  if (cfg?.browser.enabled) await ensureBrowserBinary(ask);

  let addAnother = true;
  while (addAnother) {
    const addedProvider = await addProviderInteractive(client);
    if (!addedProvider) return false;
    out(green(t('init.provider.added', { label: addedProvider.label })));
    const ans = await ask(t('init.provider.addAnother'));
    addAnother = ans.toLowerCase() === 'y';
  }

  out(`\n${bold(t('init.step3'))}`);

  const { providers: savedProviders } = requireTreatyData<ListProvidersResponse>(
    await client.treaty.v1.settings.model.providers.get()
  );

  if (savedProviders.length === 0) {
    out(yellow(t('init.noProviders')));
    return false;
  }

  // biome-ignore lint/style/noNonNullAssertion: length > 0 checked above
  let chosenProvider = savedProviders[0]!;
  if (savedProviders.length > 1) {
    chosenProvider = await selectOption(
      t('init.providers.configured'),
      savedProviders.map((provider) => ({
        label: provider.label,
        value: provider,
        detail: `(${provider.type})`
      })),
      undefined,
      t('init.provider.selectN', { n: savedProviders.length })
    );
  } else {
    out(dim(t('init.provider.using', { label: chosenProvider.label })));
  }

  out(dim(t('init.fetchingModels')));
  const { models } = requireTreatyData<ListModelsResponse>(
    await client.treaty.v1.settings.model.providers({ id: chosenProvider.id }).models.get()
  );

  const defaultModelId = await chooseDefaultModelInteractive(models);

  if (!defaultModelId) {
    out(yellow(t('init.noModel')));
    return false;
  }

  const profileAlias = 'default';
  requireTreatyData(
    await client.treaty.v1.settings.model.profiles({ alias: profileAlias }).put({
      profile: {
        alias: profileAlias,
        routes: { chat: { provider: chosenProvider.id, modelId: defaultModelId } },
        params: {},
        fallbacks: []
      }
    })
  );
  requireTreatyData(await client.treaty.v1.settings.model.default.put({ alias: profileAlias }));

  out(`\n${bold(t('init.step4'))}`);

  const agentNameInput = await ask(t('init.agent.name', { default: bold('My Agent') }));
  const agentName = agentNameInput || 'My Agent';

  const { profiles } = requireTreatyData<ListProfilesResponse>(await client.treaty.v1.settings.model.profiles.get());
  let agentModelAlias: string | undefined;
  if (profiles.length === 1) {
    agentModelAlias = profiles[0]?.alias;
    out(dim(t('init.profile.using', { alias: agentModelAlias ?? '' })));
  } else if (profiles.length > 1) {
    const profile = await selectOption(
      t('init.profiles.available'),
      profiles.map((profile) => ({
        label: profile.alias,
        value: profile,
        detail: `(${profile.routes.chat.modelId})`
      })),
      undefined,
      t('init.profile.select', { n: profiles.length })
    );
    agentModelAlias = profile.alias;
  }

  const { agent: createdAgent } = requireTreatyData<CreateAgentResponse>(
    await client.treaty.v1.agents.post({
      name: agentName,
      capabilities: [],
      ...(agentModelAlias ? { modelAlias: agentModelAlias } : {})
    })
  );
  requireTreatyData(await client.treaty.v1.agents.default.put({ agentId: createdAgent.id }));

  out('');
  out(green(t('init.success')));
  out(dim(t('init.summary.provider', { provider: chosenProvider.label, model: defaultModelId })));
  out(dim(t('init.summary.agent', { name: agentName, id: createdAgent.id })));
  return true;
}

/** Open the web browser for init; fall back to terminal if it fails. */
export async function runBrowserInit(client: MonadClient, port: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/`;
  let opened = false;

  if (process.stdout.isTTY && openUrl(url)) {
    await Bun.sleep(500);
    opened = true;
  }

  if (opened) {
    out(`\n${t('init.browser.prompt', { label: bold('monad setup') })}`);
    out(cyan(url));
    out(dim(t('init.browser.waiting')));

    // Poll until initialized.
    while (true) {
      await Bun.sleep(2000);
      const result = await client.treaty.v1.init.status.get();
      if (result.data?.initialized) {
        out(green(`\n${t('init.browser.complete')}`));
        break;
      }
    }
  } else {
    // No browser — fall back to terminal.
    out(yellow(t('init.browser.fallback')));
    await runTerminalInit(client);
  }
}
