import type { MonadMcpQuestion, MonadMcpToolView } from './monad-mcp-projection.ts';

import { CircleIcon, SquareIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

export function MonadMcpQuestionList({ view }: { view: Extract<MonadMcpToolView, { action: 'project-ask' }> }) {
  const questions = displayedQuestions(view);
  if (questions.length === 0) return null;
  return (
    <div
      className="mb-2 overflow-hidden rounded-lg border border-border/70 bg-card/35"
      data-slot="monad-mcp-questions"
    >
      {questions.map((question, index) => (
        <section
          className="border-border/60 border-b px-3 py-2.5 last:border-b-0"
          data-slot="monad-mcp-question"
          key={question.id ?? `${index}:${question.question}`}
        >
          <p className="wrap-anywhere font-medium text-foreground leading-5">{question.question}</p>
          {question.options.length > 0 ? (
            <ul className="mt-2 grid gap-1.5">
              {question.options.map((option) => (
                <li
                  className="flex min-w-0 items-start gap-2 text-foreground"
                  key={option}
                >
                  <HugeiconsIcon
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    icon={question.mode === 'multiple' ? SquareIcon : CircleIcon}
                  />
                  <span className="wrap-anywhere min-w-0">{option}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function displayedQuestions(view: Extract<MonadMcpToolView, { action: 'project-ask' }>): MonadMcpQuestion[] {
  if (view.questions?.length) return view.questions;
  if (!view.question?.trim()) return [];
  return [
    {
      ...(view.allowOther === undefined ? {} : { allowOther: view.allowOther }),
      ...(view.mode ? { mode: view.mode } : {}),
      options: view.options,
      question: view.question
    }
  ];
}
