import type { WorktreePorts } from './ports';

export interface DevInitSummaryOptions {
  apiKeySet: boolean;
  monadHome: string;
  otelUiUrl?: string;
  ports: WorktreePorts;
}

interface OutputStyleOptions {
  color?: boolean;
}

interface DevStepStatusOptions extends OutputStyleOptions {
  label: string;
  state: 'running' | 'done';
  target: string;
  tty: boolean;
  verb?: string;
}

interface DevStepProgressOptions extends OutputStyleOptions {
  frame: string;
  label: string;
  target: string;
  verb?: string;
}

interface GeneratedArtifactStatusOptions extends OutputStyleOptions {
  label: string;
  state: 'running' | 'done';
  target: string;
  tty: boolean;
}

interface GeneratedArtifactProgressOptions extends OutputStyleOptions {
  frame: string;
  label: string;
  target: string;
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
  { apiKeySet, monadHome, otelUiUrl, ports }: DevInitSummaryOptions,
  options: OutputStyleOptions = {}
): string[] {
  const useColor = options.color ?? false;
  return [
    '',
    strong('Monad dev init', useColor),
    label('Environment', useColor),
    `  ${muted('Data directory', useColor)}    ${monadHome}`,
    `  ${muted('API key', useColor)}           ${
      apiKeySet ? success('set', useColor) : warning('not set - add apiKey to packages/home/config.init.json', useColor)
    }`,
    label('Ports', useColor),
    `  ${muted('Daemon API', useColor)}        ${portUrl(ports.MONAD_PORT, 'https')}`,
    `  ${muted('Local HTTP', useColor)}        ${portUrl(ports.MONAD_HTTP_PORT)}`,
    `  ${muted('Web app', useColor)}           ${portUrl(ports.WEB_PORT)}`,
    `  ${muted('KV inspector', useColor)}      ${portUrl(ports.MONAD_KV_UI_PORT)}`,
    `  ${muted('AI SDK DevTools', useColor)}   ${portUrl(ports.AI_SDK_DEVTOOLS_PORT)}`,
    label('Runtime URL priority', useColor),
    `  ${muted('Daemon proxy', useColor)}      MONAD_URL > config network.host/https/port`,
    label('Services', useColor),
    `  ${muted('Phoenix / OTel', useColor)}    ${
      otelUiUrl || warning('not running - install Docker or start Phoenix manually', useColor)
    }`,
    ''
  ];
}

export function buildDevStepStatusFrame({
  color,
  label: stepLabel,
  state,
  target,
  tty,
  verb = 'done'
}: DevStepStatusOptions) {
  const useColor = color ?? false;
  void tty;
  if (state === 'running') return '';
  const status = success(verb, useColor);
  const line = `[dev-init] ${status} ${stepLabel} -> ${muted(target, useColor)}`;
  return `${line}\n`;
}

export function buildDevStepProgressFrame({
  color,
  frame,
  label: stepLabel,
  target,
  verb = 'running'
}: DevStepProgressOptions) {
  const useColor = color ?? false;
  return `\r[dev-init] ${colorize(frame, 'blue', useColor)} ${verb} ${stepLabel} -> ${muted(target, useColor)}`;
}

export function buildGeneratedArtifactStatusFrame(options: GeneratedArtifactStatusOptions) {
  return buildDevStepStatusFrame({ ...options, verb: 'generated' });
}

export function buildGeneratedArtifactProgressFrame(options: GeneratedArtifactProgressOptions) {
  return buildDevStepProgressFrame({ ...options, verb: 'generating' });
}

export function generatedArtifactsHeader(color: boolean): string {
  return [
    '',
    strong('Generated artifacts', color),
    muted('Tool output is shown inline below each generator.', color),
    ''
  ].join('\n');
}
