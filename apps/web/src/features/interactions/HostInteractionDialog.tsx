import type { InteractionField } from '@monad/protocol';

import { Button, Input } from '@monad/ui';
import { useEffect, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '#/components/ui/dialog';
import { initialInteractionValues, interactionSourceLabel, validateInteractionValues } from './model';
import { useHostInteractions } from './use-host-interactions';

function FormField({
  field,
  value,
  error,
  onChange
}: {
  field: InteractionField;
  value: unknown;
  error?: string;
  onChange(value: unknown): void;
}) {
  const id = `host-interaction-${field.id}`;
  const control = (() => {
    switch (field.type) {
      case 'boolean':
        return (
          <input
            checked={value === true}
            id={id}
            onChange={(event) => onChange(event.currentTarget.checked)}
            type="checkbox"
          />
        );
      case 'select':
        return (
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            id={id}
            onChange={(event) => onChange(event.currentTarget.value)}
            value={String(value ?? '')}
          >
            {field.options.map((option) => (
              <option
                key={option.value}
                value={option.value}
              >
                {option.label}
              </option>
            ))}
          </select>
        );
      default:
        return (
          <Input
            autoComplete={field.type === 'secret' ? 'off' : undefined}
            id={id}
            max={field.type === 'number' ? field.max : undefined}
            min={field.type === 'number' ? field.min : undefined}
            onChange={(event) =>
              onChange(
                field.type === 'number'
                  ? event.currentTarget.value === ''
                    ? ''
                    : event.currentTarget.valueAsNumber
                  : event.currentTarget.value
              )
            }
            type={field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : 'text'}
            value={String(value ?? '')}
          />
        );
    }
  })();

  return (
    <div className="grid gap-1.5">
      <label
        className="font-medium text-sm"
        htmlFor={id}
      >
        {field.label}
        {field.required ? ' *' : ''}
      </label>
      {field.description ? <p className="text-muted-foreground text-xs">{field.description}</p> : null}
      {control}
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}

export function HostInteractionDialog() {
  const { active, submit, cancel } = useHostInteractions();
  const request = active?.interaction.request;
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!request) return;
    setValues(initialInteractionValues(request));
    setErrors({});
  }, [request]);

  if (!active || !request) return null;

  const handleSubmit = async () => {
    const nextErrors = validateInteractionValues(request, values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    try {
      await submit(request.type === 'confirm' ? { confirmed: true } : values);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(open) => !open && void cancel('close')}
      open
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          void cancel('escape');
        }}
        showCloseButton
      >
        <DialogHeader>
          <p
            className="font-medium text-muted-foreground text-xs uppercase tracking-wide"
            data-host-source
          >
            Requested by {interactionSourceLabel(active.interaction.source)}
          </p>
          <DialogTitle>{request.title}</DialogTitle>
          <DialogDescription>
            {request.description ?? 'Provide the requested information to continue.'}
          </DialogDescription>
        </DialogHeader>

        {request.type === 'select' ? (
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) => setValues({ value: event.currentTarget.value })}
            value={String(values.value ?? '')}
          >
            {request.options.map((option) => (
              <option
                key={option.value}
                value={option.value}
              >
                {option.label}
              </option>
            ))}
          </select>
        ) : null}

        {request.type === 'form' ? (
          <div className="grid max-h-[55vh] gap-4 overflow-y-auto py-1">
            {request.fields.map((field) => (
              <FormField
                error={errors[field.id]}
                field={field}
                key={field.id}
                onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
                value={values[field.id]}
              />
            ))}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            disabled={submitting}
            onClick={() => void cancel('close')}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={submitting}
            onClick={() => void handleSubmit()}
          >
            {request.type === 'confirm'
              ? (request.confirmLabel ?? 'Confirm')
              : request.type === 'form'
                ? (request.submitLabel ?? 'Submit')
                : 'Continue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
