import type { ReactElement } from 'react';

import { keyedOptions } from '../lib/keyed-options';

export interface EditorialQuestionProps {
  answer?: string;
  options: readonly string[];
  question: string;
}

export function EditorialQuestion({ answer, options, question }: EditorialQuestionProps): ReactElement {
  return (
    <section
      className="min-w-0 max-w-[65ch]"
      data-editorial-question="true"
    >
      <p className="m-0 text-pretty font-sans font-semibold text-[17px] text-foreground leading-[1.45]">{question}</p>
      {answer ? (
        <div className="mt-3 flex min-w-0 items-start gap-2.5 border-border/60 border-t pt-3">
          <span
            aria-hidden="true"
            className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-accent-blue font-semibold text-[10px] text-white"
          >
            ✓
          </span>
          <p className="m-0 min-w-0 text-pretty break-words font-sans text-[14px] text-foreground leading-[1.55]">
            {answer}
          </p>
        </div>
      ) : options.length ? (
        <ul className="mt-3 grid list-none gap-1.5 p-0 text-[14px] text-muted-foreground leading-[1.5]">
          {keyedOptions(options).map(({ key, option }) => (
            <li
              className="flex min-w-0 items-start gap-2"
              key={key}
            >
              <span
                aria-hidden="true"
                className="mt-[0.62em] size-1 shrink-0 rounded-full bg-muted-foreground/65"
              />
              <span className="min-w-0 break-words">{option}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
