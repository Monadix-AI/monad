import type { WorktreePorts } from './ports';

export interface DevInitSummaryOptions {
  apiKeySet: boolean;
  monadHome: string;
  ports: WorktreePorts;
}

interface OutputStyleOptions {
  color?: boolean;
}

function portUrl(port: string, scheme: 'http' | 'https' = 'http'): string {
  return `${scheme}://127.0.0.1:${port}`;
}

const ansi = {
  blue: '\u001b[34m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  reset: '\u001b[0m',
  yellow: '\u001b[33m'
} as const;

function colorize(value: string, color: keyof typeof ansi, enabled: boolean): string {
  return enabled ? `${ansi[color]}${value}${ansi.reset}` : value;
}

function strong(value: string, enabled: boolean): string {
  return enabled ? `${ansi.bold}${value}${ansi.reset}` : value;
}

function label(value: string, enabled: boolean): string {
  return colorize(value, 'cyan', enabled);
}

function success(value: string, enabled: boolean): string {
  return colorize(value, 'green', enabled);
}

function warning(value: string, enabled: boolean): string {
  return colorize(value, 'yellow', enabled);
}

function muted(value: string, enabled: boolean): string {
  return colorize(value, 'dim', enabled);
}

export function shouldColorOutput(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

export function buildDevInitSummary(
  { apiKeySet, monadHome, ports }: DevInitSummaryOptions,
  options: OutputStyleOptions = {}
): string[] {
  const useColor = options.color ?? false;
  return [
    '',
    strong('Monad dev init', useColor),
    label('Environment', useColor),
    `  ${muted('Data directory', useColor)}    ${monadHome}`,
    `  ${muted('API key', useColor)}           ${
      apiKeySet
        ? success('set', useColor)
        : warning('not set - add apiKey to packages/environment/config.init.json', useColor)
    }`,
    label('Ports', useColor),
    `  ${muted('Daemon API', useColor)}        ${portUrl(ports.MONAD_PORT, 'https')}`,
    `  ${muted('Local HTTP', useColor)}        ${portUrl(ports.MONAD_HTTP_PORT)}`,
    `  ${muted('Web app', useColor)}           ${portUrl(ports.WEB_PORT)}`,
    `  ${muted('Web Storybook', useColor)}     ${portUrl(ports.WEB_STORYBOOK_PORT)}`,
    `  ${muted('UI Storybook', useColor)}      ${portUrl(ports.UI_STORYBOOK_PORT)}`,
    `  ${muted('KV inspector', useColor)}      ${portUrl(ports.MONAD_KV_UI_PORT)}`,
    `  ${muted('AI SDK DevTools', useColor)}   ${portUrl(ports.AI_SDK_DEVTOOLS_PORT)}`,
    label('Runtime URL priority', useColor),
    `  ${muted('Daemon proxy', useColor)}      MONAD_URL > config network.host/https/port`,
    label('Services', useColor),
    `  ${muted('Phoenix / OTel', useColor)}    ${warning('optional - run mise run dev:services', useColor)}`,
    ''
  ];
}
