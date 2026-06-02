// Daemon-side config runtime: secret resolution, MCP preset builders, and effective-sandbox /
// model-role resolution. The config *schema* lives in @monad/home; these helpers apply it.

import { describe, expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';

import { buildBrowserMcpServer, buildComputerMcpServer } from '@/config/mcp-presets.ts';
import { resolveEffectiveSandboxMode } from '@/config/resolve.ts';
import { resolveSecretMap, resolveSecretRef } from '@/config/secrets.ts';

describe('resolveEffectiveSandboxMode', () => {
  test('uses the per-agent mode when the global restriction is disabled', () => {
    expect(resolveEffectiveSandboxMode({ mode: 'home' }, { enabled: false, mode: 'workspace' })).toBe('home');
    expect(resolveEffectiveSandboxMode({ mode: 'unrestricted' }, { enabled: false, mode: 'workspace' })).toBe(
      'unrestricted'
    );
  });

  test('global restriction overrides the per-agent mode when enabled', () => {
    // A permissive agent is forced down to the global ceiling.
    expect(resolveEffectiveSandboxMode({ mode: 'unrestricted' }, { enabled: true, mode: 'workspace' })).toBe(
      'workspace'
    );
    // It is an override, not a min — global wins even if more permissive than the agent.
    expect(resolveEffectiveSandboxMode({ mode: 'workspace' }, { enabled: true, mode: 'home' })).toBe('home');
  });

  test('createDefaultConfig ships with the global restriction off', () => {
    const cfg = createDefaultConfig('prn_x', 'tester');
    expect(cfg.agent.globalSandbox).toEqual({ enabled: false, mode: 'workspace' });
    expect(cfg.agent.sandbox.mode).toBe('workspace');
  });
});

describe('secret resolution', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
  test('resolveSecretRef resolves ${env:NAME}', () => {
    Bun.env.MONAD_TEST_SECRET = 'sek';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
    expect(resolveSecretRef('${env:MONAD_TEST_SECRET}')).toBe('sek');
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only env var set/deleted in same block
    delete Bun.env.MONAD_TEST_SECRET;
  });

  test('resolveSecretRef passes plain values through', () => {
    expect(resolveSecretRef('plain-token')).toBe('plain-token');
  });

  test('resolveSecretRef throws on an unset env reference', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
    expect(() => resolveSecretRef('${env:MONAD_DEFINITELY_UNSET}')).toThrow(/unset/);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
  test('resolveSecretRef resolves ${secret:} from auth.json namedSecrets', () => {
    const auth = {
      version: 1 as const,
      activeProvider: null,
      updatedAt: new Date().toISOString(),
      credentialPool: {},
      namedSecrets: { github: 'ghp_tok' }
    };
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
    expect(resolveSecretRef('${secret:github}', auth)).toBe('ghp_tok');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
    expect(() => resolveSecretRef('${secret:github}')).toThrow(/unset/); // absent → unset
  });

  test('resolveSecretMap resolves every value', () => {
    Bun.env.MONAD_TEST_SECRET = 'sek';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
    expect(resolveSecretMap({ A: '${env:MONAD_TEST_SECRET}', B: 'plain' })).toEqual({ A: 'sek', B: 'plain' });
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only env var set/deleted in same block
    delete Bun.env.MONAD_TEST_SECRET;
  });
});

// ── browser preset (Playwright MCP) ────────────────────────────────────────────

describe('buildBrowserMcpServer', () => {
  // Helper: the stdio args (or [] on the http branch, which never happens here).
  const argsOf = (b: Parameters<typeof buildBrowserMcpServer>[0]) => {
    const spec = buildBrowserMcpServer(b);
    return spec.transport === 'stdio' ? (spec.args ?? []) : [];
  };

  test('produces a Playwright-MCP stdio spec (snapshot/headless)', () => {
    const spec = buildBrowserMcpServer({ enabled: true, vision: false, headless: true });
    expect(spec).toMatchObject({ name: 'browser', transport: 'stdio', command: 'npx', enabled: true });
    const args = argsOf({ enabled: true, vision: false, headless: true });
    expect(args).toContain('@playwright/mcp@latest');
    expect(args).toContain('--headless');
    expect(args).not.toContain('--caps');
  });

  test('vision uses --caps vision (current flag, not the legacy --vision)', () => {
    const args = argsOf({ enabled: true, vision: true, headless: false });
    expect(args.join(' ')).toContain('--caps vision');
    expect(args).not.toContain('--vision');
    expect(args).not.toContain('--headless');
  });

  test('engine and device map to --browser / --device', () => {
    const args = argsOf({ enabled: true, vision: false, headless: true, engine: 'firefox', device: 'iPhone 15' });
    expect(args.join(' ')).toContain('--browser firefox');
    expect(args.join(' ')).toContain('--device iPhone 15');
  });

  test('origin allow/block lists are semicolon-joined', () => {
    const args = argsOf({
      enabled: true,
      vision: false,
      headless: true,
      allowedOrigins: ['https://a.test', 'https://b.test'],
      blockedOrigins: ['https://ads.test']
    });
    expect(args.join(' ')).toContain('--allowed-origins https://a.test;https://b.test');
    expect(args.join(' ')).toContain('--blocked-origins https://ads.test');
  });

  test('read-only browser tools are auto-approved by default; mutating ones stay gated', () => {
    const spec = buildBrowserMcpServer({ enabled: true, vision: false, headless: true });
    const approved = spec.trust.autoApproveTools;
    // Must use the `browser__` separator that main.ts matches against actual tool names; the
    // `browser.` dot form never matched, so auto-approve silently no-op'd (over-gating).
    expect(approved).toContain('browser__browser_snapshot');
    expect(approved).toContain('browser__browser_take_screenshot');
    expect(approved).not.toContain('browser__browser_navigate');
    expect(approved).not.toContain('browser__browser_evaluate');
  });

  test('autoApproveReadOnly:false gates every browser tool', () => {
    const spec = buildBrowserMcpServer({ enabled: true, vision: false, headless: true, autoApproveReadOnly: false });
    expect(spec.trust.autoApproveTools).toEqual([]);
  });

  test('profile persistence flags are passed through', () => {
    const args = argsOf({
      enabled: true,
      vision: false,
      headless: true,
      userDataDir: '/p',
      storageState: '/s.json',
      isolated: true
    });
    expect(args.join(' ')).toContain('--user-data-dir /p');
    expect(args.join(' ')).toContain('--storage-state /s.json');
    expect(args).toContain('--isolated');
  });

  test('command override points at a non-Playwright server verbatim (no playwright flags)', () => {
    const spec = buildBrowserMcpServer({
      enabled: true,
      vision: false,
      headless: true,
      command: 'npx',
      args: ['chrome-devtools-mcp@latest']
    });
    expect(spec.transport === 'stdio' ? spec.command : '').toBe('npx');
    const args = spec.transport === 'stdio' ? (spec.args ?? []) : [];
    expect(args).toEqual(['chrome-devtools-mcp@latest']);
    expect(args).not.toContain('@playwright/mcp@latest');
    // Read-only auto-approve is Playwright-specific → empty for a custom server.
    expect(spec.trust.autoApproveTools).toEqual([]);
  });

  test('browser preset is NOT host-escape (it is sandboxable / domain-scopable)', () => {
    const spec = buildBrowserMcpServer({ enabled: true, vision: false, headless: true });
    expect(spec.trust.hostEscape).toBe(false);
  });
});

// ── computer-use preset (buildComputerMcpServer) ────────────────────────────────

describe('buildComputerMcpServer', () => {
  test('produces a desktop-control stdio spec with the configured command/args', () => {
    const spec = buildComputerMcpServer({ enabled: true, command: 'uvx', args: ['computer-control-mcp@latest'] });
    expect(spec).toMatchObject({
      name: 'computer',
      transport: 'stdio',
      command: 'uvx',
      enabled: true
    });
    expect(spec.transport === 'stdio' ? spec.args : []).toEqual(['computer-control-mcp@latest']);
  });

  test('command/args are overridable (point at any other server)', () => {
    const spec = buildComputerMcpServer({ enabled: true, command: 'npx', args: ['-y', 'some-other-mcp'] });
    expect(spec.transport === 'stdio' ? spec.command : '').toBe('npx');
    expect(spec.transport === 'stdio' ? spec.args : []).toEqual(['-y', 'some-other-mcp']);
  });

  test('non-visual read-only desktop tools are auto-approved; capture + input-injecting ones stay gated', () => {
    const spec = buildComputerMcpServer({ enabled: true, command: 'uvx', args: [] });
    const approved = spec.trust.autoApproveTools;
    // Uses the `computer__` separator main.ts matches against actual tool names.
    expect(approved).toContain('computer__get_cursor_position');
    expect(approved).toContain('computer__get_screen_size');
    // Screen capture is privacy-sensitive → NOT silently auto-approved (rides the host-control grant).
    expect(approved).not.toContain('computer__take_screenshot');
    expect(approved).not.toContain('computer__click_screen');
    expect(approved).not.toContain('computer__type_text');
  });

  test('autoApproveReadOnly:false gates every desktop tool', () => {
    const spec = buildComputerMcpServer({ enabled: true, command: 'uvx', args: [], autoApproveReadOnly: false });
    expect(spec.trust.autoApproveTools).toEqual([]);
  });

  test('marks the server host-escape so its mutating tools are session-gated, never permanently allowed', () => {
    const spec = buildComputerMcpServer({ enabled: true, command: 'uvx', args: [] });
    expect(spec.trust.hostEscape).toBe(true);
  });
});
