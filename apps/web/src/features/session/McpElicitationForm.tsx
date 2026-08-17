import type { ClarifyAsker, ClarifyForm, ClarifyRespondRequest } from '@monad/protocol';

import { Button } from '@monad/ui';
import { useMemo, useState } from 'react';

import { useT } from '#/components/I18nProvider';

type FormValue = boolean | number | string | string[];

export function McpElicitationForm({
  asker,
  form,
  onAnswer
}: {
  asker?: ClarifyAsker;
  form: ClarifyForm;
  onAnswer: (response: Omit<ClarifyRespondRequest, 'requestId'>) => void;
}) {
  const t = useT();
  const defaults = useMemo(
    () =>
      Object.fromEntries(
        form.fields.flatMap((field) => (field.defaultValue === undefined ? [] : [[field.name, field.defaultValue]]))
      ) as Record<string, FormValue>,
    [form.fields]
  );
  const [values, setValues] = useState<Record<string, FormValue>>(defaults);
  const [reviewing, setReviewing] = useState(false);

  if (reviewing) {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-md border border-border bg-background p-3">
          <div className="mb-2 font-medium text-sm">{t('web.chat.elicitationReview')}</div>
          <dl className="grid gap-2 text-sm">
            {form.fields.map((field) => (
              <div
                className="grid grid-cols-[minmax(7rem,0.4fr)_1fr] gap-3"
                key={field.name}
              >
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="wrap-break-word">
                  {displayValue(
                    field.options,
                    values[field.name],
                    t('web.chat.elicitationTrue'),
                    t('web.chat.elicitationFalse')
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => setReviewing(false)}
            size="sm"
            variant="outline"
          >
            {t('web.chat.elicitationEdit')}
          </Button>
          <Button
            onClick={() => onAnswer({ answer: JSON.stringify(values) })}
            size="sm"
          >
            {t('web.common.submit')}
          </Button>
          <Button
            onClick={() => onAnswer({ answer: '' })}
            size="sm"
            variant="ghost"
          >
            {t('web.common.cancel')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setReviewing(true);
      }}
    >
      {asker && (
        <div className="text-muted-foreground text-xs">{t('web.chat.elicitationFrom', { server: asker.name })}</div>
      )}
      {form.fields.map((field) => {
        const value = values[field.name];
        const setValue = (next: FormValue) => setValues((current) => ({ ...current, [field.name]: next }));
        return (
          <div
            className="flex flex-col gap-1.5 text-sm"
            key={field.name}
          >
            <span className="font-medium">
              {field.label}
              {field.required && <span className="ml-1 text-danger">*</span>}
            </span>
            {field.description && <span className="text-muted-foreground text-xs">{field.description}</span>}
            {field.type === 'boolean' ? (
              <input
                aria-label={field.label}
                checked={value === true}
                className="size-4"
                onChange={(event) => setValue(event.target.checked)}
                type="checkbox"
              />
            ) : field.type === 'single-select' ? (
              <select
                aria-label={field.label}
                className="h-9 rounded-md border border-input bg-background px-3"
                onChange={(event) => setValue(event.target.value)}
                required={field.required}
                value={typeof value === 'string' ? value : ''}
              >
                <option value="" />
                {field.options?.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === 'multi-select' ? (
              <span className="flex flex-wrap gap-2">
                {field.options?.map((option) => {
                  const selected = Array.isArray(value) ? value : [];
                  return (
                    <span
                      className="flex items-center gap-1.5"
                      key={option.value}
                    >
                      <input
                        aria-label={`${field.label}: ${option.label}`}
                        checked={selected.includes(option.value)}
                        onChange={(event) =>
                          setValue(
                            event.target.checked
                              ? [...selected, option.value]
                              : selected.filter((item) => item !== option.value)
                          )
                        }
                        type="checkbox"
                      />
                      {option.label}
                    </span>
                  );
                })}
              </span>
            ) : (
              <input
                aria-label={field.label}
                className="h-9 rounded-md border border-input bg-background px-3"
                defaultValue={value === undefined ? '' : String(value)}
                max={field.maximum}
                maxLength={field.maxLength}
                min={field.minimum}
                minLength={field.minLength}
                onChange={(event) =>
                  setValue(
                    field.type === 'number' || field.type === 'integer'
                      ? event.target.value === ''
                        ? ''
                        : event.target.valueAsNumber
                      : event.target.value
                  )
                }
                pattern={field.pattern}
                required={field.required}
                step={field.type === 'integer' ? 1 : field.type === 'number' ? 'any' : undefined}
                type={inputType(field.format, field.type)}
              />
            )}
          </div>
        );
      })}
      <Button
        className="self-start"
        size="sm"
        type="submit"
      >
        {t('web.chat.elicitationReviewAction')}
      </Button>
    </form>
  );
}

function inputType(format: ClarifyForm['fields'][number]['format'], type: ClarifyForm['fields'][number]['type']) {
  if (type === 'number' || type === 'integer') return 'number';
  if (format === 'email') return 'email';
  if (format === 'uri') return 'url';
  if (format === 'date') return 'date';
  if (format === 'date-time') return 'datetime-local';
  return 'text';
}

function displayValue(
  options: ClarifyForm['fields'][number]['options'],
  value: FormValue | undefined,
  trueLabel: string,
  falseLabel: string
): string {
  if (value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? trueLabel : falseLabel;
  const values = Array.isArray(value) ? value : [String(value)];
  return values.map((item) => options?.find((option) => option.value === item)?.label ?? item).join(', ');
}
