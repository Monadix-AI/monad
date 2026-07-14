import { createHash } from 'node:crypto';
import { Eta } from 'eta';

export interface PromptTemplate<TData extends object> {
  readonly id: string;
  readonly sourceHash: string;
  readonly sourcePath: string;
  render(data: TData): string;
}

export interface DefinePromptOptions {
  id: string;
  sourcePath: string;
}

const eta = new Eta({
  autoEscape: false,
  autoTrim: false,
  cache: true,
  debug: false,
  useWith: false
});

const promptIds = new Map<string, string>();
const etaTags = /<%[\s\S]*?%>/g;
const legacySlot = /\{\{[A-Z][A-Z0-9_]*\}\}/;
const forbiddenEtaCode =
  /\b(?:include|includeFile|layout|block|capture|captureAsync|fetch|require)\s*\(|\bawait\b|\bimport\s*\(|\b(?:process|Bun)\s*\./;

function validateSource(id: string, source: string): void {
  if (!source.trim()) throw new Error(`prompt "${id}" has empty source`);
  if (legacySlot.test(source)) throw new Error(`prompt "${id}" contains a legacy slot`);

  for (const match of source.matchAll(etaTags)) {
    if (forbiddenEtaCode.test(match[0])) throw new Error(`prompt "${id}" contains forbidden Eta code`);
  }
}

function registerId(id: string, sourcePath: string): void {
  const existing = promptIds.get(id);
  if (existing && existing !== sourcePath) throw new Error(`prompt id "${id}" is already registered by ${existing}`);
  promptIds.set(id, sourcePath);
}

export async function definePrompt<TData extends object = Record<string, never>>({
  id,
  sourcePath
}: DefinePromptOptions): Promise<PromptTemplate<TData>> {
  const source = (await Bun.file(sourcePath).text()).trim();
  validateSource(id, source);
  registerId(id, sourcePath);
  const sourceHash = createHash('sha256').update(source).digest('hex');

  return {
    id,
    sourceHash,
    sourcePath,
    render(data) {
      const output = eta.renderString(source, data).trim();
      if (!output) throw new Error(`prompt "${id}" rendered empty output`);
      return output;
    }
  };
}
