import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const docsRoot = resolve(root, 'docs');
const config = JSON.parse(await readFile(resolve(docsRoot, 'docs.json'), 'utf8')) as { navigation?: unknown };
const mintIgnore = await readFile(resolve(docsRoot, '.mintignore'), 'utf8');

async function markdownPages(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return markdownPages(path);
      if (!entry.isFile() || !entry.name.endsWith('.md')) return [];
      return [relative(docsRoot, path).replaceAll('\\', '/').replace(/\.md$/, '')];
    })
  );
  return nested.flat();
}

function navigationPages(value: unknown, pages: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) navigationPages(item, pages);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'pages' && Array.isArray(child)) {
      for (const page of child) {
        if (typeof page === 'string') pages.push(page.replace(/^\//, '').replace(/\.md$/, ''));
        else navigationPages(page, pages);
      }
      continue;
    }
    navigationPages(child, pages);
  }
}

const discoveredFiles = (await markdownPages(docsRoot)).sort();
const internalFiles = discoveredFiles.filter((page) => page.startsWith('internal/'));
const publishedFiles = discoveredFiles.filter((page) => page !== 'README' && !page.startsWith('internal/'));
const navigation: string[] = [];
navigationPages(config.navigation, navigation);
const files = publishedFiles.map(
  (page) => navigation.find((listedPage) => listedPage.toLowerCase() === page.toLowerCase()) ?? page
);
const listed = [...new Set(navigation)].sort();
const duplicatePages = navigation.filter((page, index) => navigation.indexOf(page) !== index);
const missingFromNavigation = files.filter((page) => !listed.includes(page));
const missingFiles = listed.filter((page) => !files.includes(page));
const invalidFrontmatter: string[] = [];
const missingDescriptions: string[] = [];
const unlabeledCodeFences: string[] = [];
const invalidInternalAudience: string[] = [];
const brokenInternalLinks: string[] = [];

for (const page of files) {
  const body = await readFile(resolve(docsRoot, `${page}.md`), 'utf8');
  if (!/^---\n[\s\S]*?^title:\s*.+$[\s\S]*?^---$/m.test(body)) invalidFrontmatter.push(`${page}.md`);
  if (!/^---\n[\s\S]*?^description:\s*.+$[\s\S]*?^---$/m.test(body)) missingDescriptions.push(`${page}.md`);

  let codeFenceOpen = false;
  for (const [index, line] of body.split('\n').entries()) {
    if (!line.startsWith('```')) continue;
    if (!codeFenceOpen && line.trim() === '```') unlabeledCodeFences.push(`${page}.md:${index + 1}`);
    codeFenceOpen = !codeFenceOpen;
  }
}

for (const page of internalFiles) {
  const file = resolve(docsRoot, `${page}.md`);
  const body = await readFile(file, 'utf8');
  const audience = page.startsWith('internal/agents/') ? 'internal-agent' : 'internal-developer';
  if (!new RegExp(`^audience:\\s*["']?${audience}["']?\\s*$`, 'm').test(body)) {
    invalidInternalAudience.push(`${page}.md (expected ${audience})`);
  }
  for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
    const href = match[1]?.trim();
    if (!href || href.startsWith('#') || href.startsWith('/') || /^[a-z]+:/i.test(href)) continue;
    const target = href.split('#', 1)[0]?.split(' ', 1)[0];
    if (!target) continue;
    await access(resolve(dirname(file), decodeURIComponent(target))).catch(() => {
      brokenInternalLinks.push(`${page}.md -> ${href}`);
    });
  }
}

const failures = [
  !mintIgnore.split('\n').some((line) => line.trim() === 'internal/') ? 'docs/.mintignore must exclude internal/' : '',
  navigation.some((page) => page.startsWith('internal/'))
    ? 'Repository-only pages must not appear in Mintlify navigation'
    : '',
  duplicatePages.length > 0 ? `Pages listed more than once:\n  ${[...new Set(duplicatePages)].join('\n  ')}` : '',
  missingFromNavigation.length > 0
    ? `Markdown files missing from navigation:\n  ${missingFromNavigation.join('\n  ')}`
    : '',
  missingFiles.length > 0 ? `Navigation entries without Markdown files:\n  ${missingFiles.join('\n  ')}` : '',
  invalidFrontmatter.length > 0 ? `Pages missing title frontmatter:\n  ${invalidFrontmatter.join('\n  ')}` : '',
  missingDescriptions.length > 0 ? `Pages missing description frontmatter:\n  ${missingDescriptions.join('\n  ')}` : '',
  unlabeledCodeFences.length > 0 ? `Code fences missing a language:\n  ${unlabeledCodeFences.join('\n  ')}` : '',
  invalidInternalAudience.length > 0
    ? `Internal pages missing the expected audience marker:\n  ${invalidInternalAudience.join('\n  ')}`
    : '',
  brokenInternalLinks.length > 0
    ? `Broken links in repository-only documentation:\n  ${brokenInternalLinks.join('\n  ')}`
    : ''
].filter(Boolean);

if (failures.length > 0) throw new Error(failures.join('\n\n'));
process.stdout.write(
  `Validated ${files.length} Mintlify pages and ${internalFiles.length} repository-only pages; publication boundaries are explicit.\n`
);
