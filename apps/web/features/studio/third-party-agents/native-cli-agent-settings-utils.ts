import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type {
  NativeCliAgentPresetView,
  NativeCliAgentView,
  NativeCliProjectTemplate,
  NativeCliSettingsImportItem
} from '@monad/protocol';

export const argsToStr = (args?: string[]): string => (args ?? []).join(' ');
export const strToArgs = (s: string): string[] => s.split(/\s+/).filter(Boolean);
export const modelOptionsToStr = (modelOptions?: string[]): string => (modelOptions ?? []).join('\n');
export const strToModelOptions = (s: string): string[] =>
  s
    .split(/\r?\n|,/)
    .map((part) => part.trim())
    .filter(Boolean);
export const envToStr = (env?: Record<string, string>): string =>
  Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
export const strToEnv = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
};

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function canApplyImportItem(item: NativeCliSettingsImportItem): boolean {
  return item.category === 'nativeCliAgents' && (item.action === 'add' || item.action === 'update');
}

export const nextTemplateId = (templates: readonly NativeCliProjectTemplate[]): string => {
  for (let index = templates.length + 1; index < 1000; index += 1) {
    const candidate = `template-${index}`;
    if (!templates.some((template) => template.id === candidate)) return candidate;
  }
  return `template-${Date.now().toString(36)}`;
};

export const normalizeProjectTemplates = (templates: readonly NativeCliProjectTemplate[]): NativeCliProjectTemplate[] =>
  templates
    .map((template) => ({
      id: template.id.trim(),
      displayName: template.displayName.trim(),
      ...(template.modelId?.trim() ? { modelId: template.modelId.trim() } : {}),
      ...(template.reasoningEffort?.trim() ? { reasoningEffort: template.reasoningEffort.trim() } : {}),
      ...(template.speed ? { speed: template.speed } : {}),
      ...(template.customPrompt?.trim() ? { customPrompt: template.customPrompt.trim() } : {})
    }))
    .filter((template) => template.id && template.displayName);

export type ProjectTemplateEditorRow = NativeCliProjectTemplate & { rowKey: string };

export const newProjectTemplateEditorRow = (
  template: NativeCliProjectTemplate,
  fallbackKey: string = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
): ProjectTemplateEditorRow => ({ ...template, rowKey: fallbackKey });

export const BLANK_AGENT: NativeCliAgentView = {
  name: '',
  provider: 'codex',
  command: '',
  args: [],
  modelOptions: [],
  enabled: true,
  defaultLaunchMode: 'pty',
  allowAutopilot: true,
  approvalOwnership: 'provider-owned'
};

export const presetToView = (p: NativeCliAgentPresetView): NativeCliAgentView => ({
  name: p.id,
  provider: p.provider,
  productIcon: p.productIcon,
  command: p.command,
  args: p.args,
  modelOptions: p.modelOptions,
  reasoningEfforts: p.reasoningEfforts,
  enabled: true,
  defaultLaunchMode: p.defaultLaunchMode,
  allowAutopilot: true,
  approvalOwnership: 'provider-owned',
  capabilities: p.capabilities
});

export const presetForAgent = (
  agent: NativeCliAgentView,
  presets: readonly NativeCliAgentPresetView[]
): NativeCliAgentPresetView | undefined =>
  presets.find((preset) => preset.id === agent.name || preset.provider === agent.provider);

export function presetHintKey(id: string): WebMessageIdWithoutParams {
  return `web.nativeCli.presetHint.${id}` as WebMessageIdWithoutParams;
}
