import type { ModelResult, ModelRouter } from '@/agent/model/index.ts';

// `with { type: 'file' }` embeds reliably in bun's --compile binary (unlike new URL+import.meta.url).
import reviewPromptPath from './prompts/skill-install-review-prompt.md' with { type: 'file' };

const MAX_REVIEW_CHARS = 48_000;
const SKILL_INSTALL_REVIEW_PROMPT = (await Bun.file(reviewPromptPath).text()).trim();

export interface SkillInstallReviewInput {
  files: Map<string, Uint8Array>;
  model: ModelRouter;
  modelSpec: string;
  skills: string[];
  source: string;
}

type InstallReviewWarningCode =
  | 'failure:no-usable-model'
  | 'failure:model-request-failed'
  | 'failure:invalid-json'
  | 'failure:no-readable-text'
  | 'risk';

export interface SkillInstallReviewWarning {
  code: InstallReviewWarningCode;
  reason?: string;
}

export type SkillInstallReviewWarnings = SkillInstallReviewWarning[];

export function warningToString(warning: SkillInstallReviewWarning): string {
  switch (warning.code) {
    case 'risk':
      return `install review flagged this skill: ${warning.reason || 'model classified the skill as risky'}`;
    case 'failure:no-usable-model':
      return 'install review failed: no usable model is available';
    case 'failure:model-request-failed':
      return `install review failed: model request failed${warning.reason ? `: ${warning.reason}` : ''}`;
    case 'failure:invalid-json':
      return 'install review failed: model returned invalid JSON';
    case 'failure:no-readable-text':
      return 'install review failed: no readable text';
    default:
      return 'install review failed';
  }
}

export function warningsToStrings(warnings: SkillInstallReviewWarnings): string[] {
  return warnings.map(warningToString);
}

export function warningModelRequestFailed(error: unknown): SkillInstallReviewWarning {
  return { code: 'failure:model-request-failed', reason: error instanceof Error ? error.message : String(error) };
}

function textFilesForReview(files: Map<string, Uint8Array>): string {
  const decoder = new TextDecoder();
  let remaining = MAX_REVIEW_CHARS;
  const chunks: string[] = [];

  for (const [path, bytes] of files) {
    if (remaining <= 0) break;
    if (bytes.includes(0)) continue;
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    const slice = text.slice(0, remaining);
    chunks.push(`--- ${path} ---\n${slice}`);
    remaining -= slice.length;
  }

  return chunks.join('\n\n');
}

function parseReviewResult(text: string): { reason?: string; risky: boolean } | null {
  const trimmed = text.trim();
  const json = trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
  try {
    const parsed = JSON.parse(json) as { reason?: unknown; risky?: unknown };
    if (typeof parsed.risky !== 'boolean') return null;
    return {
      risky: parsed.risky,
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined
    };
  } catch {
    return null;
  }
}

export async function reviewSkillInstall(input: SkillInstallReviewInput): Promise<SkillInstallReviewWarnings> {
  const body = textFilesForReview(input.files);
  if (!body) return [{ code: 'failure:no-readable-text' }];

  let result: ModelResult;
  try {
    result = await input.model.complete({
      model: input.modelSpec,
      messages: [
        {
          role: 'system',
          content: SKILL_INSTALL_REVIEW_PROMPT
        },
        {
          role: 'user',
          content: `Source: ${input.source}\nSkills: ${input.skills.join(', ')}\n\n${body}`
        }
      ],
      params: { temperature: 0 },
      maxThinkingTokens: 0
    });
  } catch (error) {
    return [warningModelRequestFailed(error)];
  }

  const parsed = parseReviewResult(result.text);
  if (!parsed) return [{ code: 'failure:invalid-json' }];
  if (!parsed.risky) return [];
  return [{ code: 'risk', reason: parsed.reason || 'model classified the skill as risky' }];
}
