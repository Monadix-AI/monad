const ESC = '\u001b';

function stripTerminalEscapes(text: string): string {
  return text
    .replace(new RegExp(`${ESC}\\][\\s\\S]*?(?:\\u0007|${ESC}\\\\)`, 'g'), '')
    .replace(new RegExp(`${ESC}[P^_X][\\s\\S]*?(?:\\u0007|${ESC}\\\\)`, 'g'), '')
    .replace(new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g'), '')
    .replace(new RegExp(`${ESC}[ -/]*[@-~]`, 'g'), '');
}

function applyLineControls(text: string): string {
  const lines: string[][] = [[]];
  let row = 0;
  let col = 0;
  for (const char of text) {
    if (char === '\n') {
      row += 1;
      col = 0;
      lines[row] ??= [];
      continue;
    }
    if (char === '\r') {
      lines[row] = [];
      col = 0;
      continue;
    }
    if (char === '\b') {
      col = Math.max(0, col - 1);
      lines[row]?.splice(col, 1);
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 32 && char !== '\t') continue;
    lines[row] ??= [];
    lines[row][col] = char;
    col += 1;
  }
  return lines.map((line) => line.join('').trimEnd()).join('\n');
}

export function humanReadableCliOutput(output: string): string {
  return applyLineControls(stripTerminalEscapes(output))
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}
