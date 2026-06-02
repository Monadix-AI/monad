export interface FailedTestCase {
  file: string;
  name: string;
}

export interface FailedTestFile {
  file: string;
  names: string[];
  pattern?: string;
}

export function parseFailedCases(xml: string): FailedTestCase[] {
  const failed: FailedTestCase[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*[^/])>([\s\S]*?)<\/testcase>/g)) {
    const attrsSource = match[1];
    const body = match[2];
    if (!attrsSource || !body) continue;
    if (!body.includes('<failure') && !body.includes('<error')) continue;
    const attrs = Object.fromEntries(
      [...attrsSource.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, decodeXml(value ?? '')])
    );
    if (attrs.file && attrs.name) failed.push({ file: attrs.file, name: attrs.name });
  }
  return failed;
}

export function groupFailedCases(cases: FailedTestCase[]): FailedTestFile[] {
  const byFile = new Map<string, Set<string>>();
  for (const testCase of cases) {
    const names = byFile.get(testCase.file) ?? new Set<string>();
    names.add(testCase.name);
    byFile.set(testCase.file, names);
  }
  return [...byFile].map(([file, names]) => {
    const list = [...names];
    const hasUnnamed = list.includes('(unnamed)');
    return {
      file,
      names: list,
      ...(hasUnnamed ? {} : { pattern: `(?:${list.map(escapeRegex).join('|')})$` })
    };
  });
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
