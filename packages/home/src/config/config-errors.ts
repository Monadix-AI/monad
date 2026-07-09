import { ZodError } from 'zod';

export function friendlySchemaError(
  fileLabel: 'config.json' | 'profile.json' | 'sandbox.json' | 'auth.json',
  filePath: string,
  err: unknown
): Error {
  if (!(err instanceof ZodError)) {
    return new Error(
      `monad: ${fileLabel} is invalid at ${filePath}. ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const details = formatIssuesTable(err.issues);

  return new Error(
    `monad: ${fileLabel} has invalid fields at ${filePath}.\n` + `Please correct these items and restart:\n\n${details}`
  );
}

function formatIssuesTable(issues: ZodError['issues']): string {
  const rows = issues.map((issue) => ({
    path: sanitizeCell(issue.path.length ? issue.path.join('.') : '(root)'),
    message: sanitizeCell(issue.message)
  }));

  const pathHeader = 'Path';
  const issueHeader = 'Issue';
  const columns = Number(process.stdout?.columns ?? 120);
  const maxTableWidth = Math.max(70, Math.min(columns - 2, 140));
  const fixedOverhead = 7; // "| " + " | " + " |"
  const maxPathWidth = 36;
  const minPathWidth = 8;
  const minIssueWidth = 20;

  const naturalPathWidth = Math.max(pathHeader.length, ...rows.map((r) => r.path.length));
  const pathWidth = Math.max(minPathWidth, Math.min(naturalPathWidth, maxPathWidth));
  const issueWidth = Math.max(minIssueWidth, maxTableWidth - fixedOverhead - pathWidth);

  const line = `+-${'-'.repeat(pathWidth)}-+-${'-'.repeat(issueWidth)}-+`;
  const header = `| ${pathHeader.padEnd(pathWidth)} | ${issueHeader.padEnd(issueWidth)} |`;
  const body = rows
    .flatMap((r) => {
      const pathLines = wrapCell(r.path, pathWidth);
      const messageLines = wrapCell(r.message, issueWidth);
      const height = Math.max(pathLines.length, messageLines.length);
      const lines: string[] = [];
      for (let i = 0; i < height; i++) {
        const p = pathLines[i] ?? '';
        const m = messageLines[i] ?? '';
        lines.push(`| ${p.padEnd(pathWidth)} | ${m.padEnd(issueWidth)} |`);
      }
      return lines;
    })
    .join('\n');

  return [line, header, line, body, line].join('\n');
}

function sanitizeCell(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function wrapCell(text: string, width: number): string[] {
  if (text.length <= width) return [text];

  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (!word) continue;
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += width) {
        lines.push(word.slice(i, i + width));
      }
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines.length ? lines : [''];
}
