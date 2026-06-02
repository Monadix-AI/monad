const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

const ANSI_OUTPUT_TOOL_NAMES = new Set(['shell_exec', 'shell', 'exec_command']);

export function shouldStripAnsiForTool(toolName: string): boolean {
  return ANSI_OUTPUT_TOOL_NAMES.has(toolName);
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function stripAnsiFromToolOutput(toolName: string, text: string): string {
  return shouldStripAnsiForTool(toolName) ? stripAnsi(text) : text;
}
