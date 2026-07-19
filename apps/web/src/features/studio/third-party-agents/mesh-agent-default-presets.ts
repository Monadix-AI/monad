import type { MeshAgentPresetView } from '@monad/protocol';

export const DETECTING_MESH_AGENT_PRESETS: MeshAgentPresetView[] = [
  {
    id: 'codex',
    label: 'Codex',
    provider: 'codex',
    productIcon: 'codex',
    command: 'codex',
    args: [],
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
    installHint: '',
    installUrl: 'https://github.com/NousResearch/hermes-agent',
    installed: false
  }
];
