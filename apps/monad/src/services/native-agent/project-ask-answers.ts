import { z } from 'zod';

const answerSchema = z.union([z.string(), z.array(z.string())]);

export function parseProjectAskAnswers(
  questions: readonly { id: string }[],
  answer: string
): Record<string, string | string[]> {
  if (!answer.trim()) return {};
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (questions.length > 1 && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return z.record(z.string(), answerSchema).parse(parsed);
    }
    if (questions.length === 1) {
      return { [questions[0]?.id ?? 'q1']: answerSchema.parse(parsed) };
    }
  } catch {
    if (questions.length === 1) return { [questions[0]?.id ?? 'q1']: answer };
  }
  return {};
}
