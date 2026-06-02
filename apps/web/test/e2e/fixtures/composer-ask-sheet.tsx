import { ComposerAskSheet } from '@monad/ui/components/ComposerAskSheet';
import { EditorialQuestion } from '@monad/ui/components/EditorialQuestion';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import '../../../src/styles/globals.css';

type Result = { answer: string; requestId: string; type: 'answered' } | { requestId: string; type: 'dismissed' };

declare global {
  interface Window {
    composerAskSheetHarness: {
      result: () => Result | null;
    };
  }
}

function Harness(): React.ReactElement {
  const params = new URLSearchParams(window.location.search);
  const multiple = params.get('mode') === 'multiple';
  const allowOther = params.get('other') === '1';
  const showRecord = params.get('record') === '1';
  const [result, setResult] = useState<Result | null>(null);

  document.documentElement.classList.toggle('dark', params.get('theme') === 'dark');

  window.composerAskSheetHarness = { result: () => result };

  return (
    <main className="mx-auto my-12 max-w-2xl">
      {showRecord ? (
        <div className="max-w-xl rounded-lg border border-border/65 bg-card/70 px-4 py-3 text-foreground">
          <EditorialQuestion
            answer="Revise"
            options={['Ship', 'Revise']}
            question="Proceed?"
          />
        </div>
      ) : (
        <ComposerAskSheet
          askedLabel="asked"
          asker={<span>Codex</span>}
          backLabel="Back"
          buildAnswer={(selected, other) => {
            const answers = [...selected, ...(other.trim() ? [other.trim()] : [])];
            return answers.length ? answers.join(' | ') : null;
          }}
          dismissLabel="Dismiss"
          nextLabel="Next"
          onAnswer={(requestId, answer) => setResult({ answer, requestId, type: 'answered' })}
          onDismiss={(requestId) => setResult({ requestId, type: 'dismissed' })}
          otherAriaLabel="Other answer"
          otherPlaceholder="Type another answer"
          position={1}
          question={{
            allowOther,
            id: 'clarify_1',
            mode: multiple ? 'multiple' : 'single',
            options: ['Ship', 'Revise'],
            question: 'Proceed?'
          }}
          questions={
            params.get('card') === 'multi'
              ? [
                  {
                    allowOther: false,
                    id: 'scope',
                    mode: 'single',
                    options: ['All', 'Changed'],
                    question: 'Scope?'
                  },
                  {
                    allowOther: true,
                    id: 'targets',
                    mode: 'multiple',
                    options: ['Codex', 'Claude'],
                    question: 'Targets?'
                  }
                ]
              : undefined
          }
          submitLabel="Submit"
          total={1}
        />
      )}
      <output aria-label="Result">{result ? JSON.stringify(result) : 'pending'}</output>
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />);
