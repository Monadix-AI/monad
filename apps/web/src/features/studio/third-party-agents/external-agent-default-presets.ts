import type { ExternalAgentPresetView } from '@monad/protocol';

export const DETECTING_EXTERNAL_AGENT_PRESETS: ExternalAgentPresetView[] = [
  {
    id: 'codex',
    label: 'Codex',
    provider: 'codex',
    productIcon: 'codex',
    command: 'codex',
    args: [],
    defaultLaunchMode: 'pty',
    supportedLaunchModes: ['pty'],
    installHint: '',
    installUrl: 'https://developers.openai.com/codex/cli',
    installed: false
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    provider: 'claude-code',
    productIcon: 'claude-code',
    command: 'claude',
    args: [],
    defaultLaunchMode: 'pty',
    supportedLaunchModes: ['pty'],
    installHint: '',
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview',
    installed: false
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    provider: 'gemini',
    productIcon: 'gemini',
    command: 'gemini',
    args: [],
    defaultLaunchMode: 'pty',
    supportedLaunchModes: ['pty'],
    installHint: '',
    installUrl: 'https://github.com/google-gemini/gemini-cli',
    installed: false
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    provider: 'qwen',
    productIcon: 'qwen',
    command: 'qwen',
    args: [],
    defaultLaunchMode: 'pty',
    supportedLaunchModes: ['pty'],
    installHint: '',
    installUrl: 'https://github.com/QwenLM/qwen-code',
    installed: false
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    provider: 'openclaw',
    productIcon: 'openclaw',
    command: 'openclaw',
    args: [],
    defaultLaunchMode: 'pty',
    supportedLaunchModes: ['pty'],
    installHint: '',
    installUrl: 'https://github.com/openclaw/openclaw',
    installed: false
  },
  {
    id: 'hermes',
    label: 'Hermes',
    provider: 'hermes',
    productIcon: 'hermes',
    command: 'hermes',
    args: [],
    defaultLaunchMode: 'pty',
    supportedLaunchModes: ['pty'],
    installHint: '',
    installUrl: 'https://github.com/NousResearch/hermes-agent',
    installed: false
  }
];
