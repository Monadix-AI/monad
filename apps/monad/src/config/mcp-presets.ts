import type { BrowserConfig, ComputerConfig, McpServerConfig, ObscuraConfig } from '@monad/home';

// Conservative list: only tools that don't change page/browser state. Anything that
// navigates, interacts, evaluates JS, or writes cookies/storage stays gated.
// Names are @playwright/mcp tool names; the daemon namespaces them as `browser__<name>`
// (see sanitizeToolName / connectMcpServer) and main.ts matches autoApproveTools against
// that exact form — so the prefix MUST be `browser__`, not `browser.`.
const BROWSER_READONLY_TOOLS = [
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_console_messages',
  'browser_network_requests',
  'browser_network_request',
  'browser_cookie_get',
  'browser_cookie_list',
  'browser_localstorage_get',
  'browser_localstorage_list',
  'browser_sessionstorage_get',
  'browser_sessionstorage_list',
  'browser_storage_state',
  'browser_get_config',
  'browser_generate_locator',
  'browser_pdf_save',
  'browser_verify_element_visible',
  'browser_verify_list_visible',
  'browser_verify_text_visible',
  'browser_verify_value'
];

export function buildBrowserMcpServer(browser: BrowserConfig): McpServerConfig {
  // Custom server override: use the operator's command/args verbatim. Read-only auto-approve is
  // Playwright-specific, so it's empty here (everything gates) — for fine-grained trust on a custom
  // server, define a full `mcpServers` entry named "browser" instead (it takes precedence).
  if (browser.command) {
    return {
      name: 'browser',
      transport: 'stdio',
      command: browser.command,
      args: browser.args ?? [],
      enabled: true,
      trust: { autoApproveTools: [], hostEscape: false }
    };
  }
  const args = ['-y', '@playwright/mcp@latest'];
  if (browser.vision) args.push('--caps', 'vision'); // --caps vision is the current flag; older builds used --vision
  if (browser.headless) args.push('--headless');
  if (browser.engine) args.push('--browser', browser.engine);
  if (browser.device) args.push('--device', browser.device);
  if (browser.allowedOrigins?.length) args.push('--allowed-origins', browser.allowedOrigins.join(';'));
  if (browser.blockedOrigins?.length) args.push('--blocked-origins', browser.blockedOrigins.join(';'));
  if (browser.userDataDir) args.push('--user-data-dir', browser.userDataDir);
  if (browser.storageState) args.push('--storage-state', browser.storageState);
  if (browser.isolated) args.push('--isolated');
  const autoApproveTools =
    browser.autoApproveReadOnly !== false ? BROWSER_READONLY_TOOLS.map((t) => `browser__${t}`) : [];
  // Not host-escape: a browser is domain-scopable and far more contained than desktop control.
  return {
    name: 'browser',
    transport: 'stdio',
    command: 'npx',
    args,
    enabled: true,
    trust: { autoApproveTools, hostEscape: false }
  };
}

// Non-visual read-only desktop tools (no input injected, no pixels captured) — safe to auto-approve.
// Names track the configured server (defaults to AB498/computer-control-mcp); the daemon namespaces
// them as `computer__<name>`. A name the server doesn't expose simply never matches (fail-safe).
// NOTE: screen CAPTURE is deliberately excluded — a screenshot can expose passwords/private content,
// so on a hostEscape server it falls under the host-control session grant (flows once the user grants
// control, prompts otherwise) rather than being silently auto-approved.
const COMPUTER_READONLY_TOOLS = ['get_screen_size', 'get_cursor_position', 'list_windows'];

export function buildComputerMcpServer(computer: ComputerConfig): McpServerConfig {
  const autoApproveTools =
    computer.autoApproveReadOnly !== false ? COMPUTER_READONLY_TOOLS.map((t) => `computer__${t}`) : [];
  return {
    name: 'computer',
    transport: 'stdio',
    command: computer.command,
    args: computer.args,
    ...(computer.env ? { env: computer.env } : {}),
    enabled: true,
    // hostEscape: every non-read-only tool drives the real desktop → gated as host-escape
    // (session-grantable, never a permanent global allow). Read-only tools stay in autoApproveTools.
    trust: { autoApproveTools, hostEscape: true }
  };
}

const OBSCURA_READONLY_TOOLS = ['browser_snapshot', 'browser_console_messages', 'browser_network_requests'];

export function buildObscuraMcpServer(cfg: ObscuraConfig, command = 'obscura'): McpServerConfig {
  const args = ['mcp'];
  if (cfg.stealth) args.push('--stealth');
  return {
    name: 'obscura',
    transport: 'stdio',
    command,
    args,
    ...(cfg.requestTimeoutMs !== undefined && { requestTimeoutMs: cfg.requestTimeoutMs }),
    enabled: true,
    trust: { autoApproveTools: OBSCURA_READONLY_TOOLS.map((t) => `obscura__${t}`), hostEscape: false }
  };
}
