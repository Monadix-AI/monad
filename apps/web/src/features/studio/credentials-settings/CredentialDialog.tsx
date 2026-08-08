import type { AgentCredentialView, CreateAgentCredentialRequest, UpdateAgentCredentialRequest } from '@monad/protocol';

import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea
} from '@monad/ui';
import { useMemo, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '#/components/ui/dialog';
import { SECRET_INPUT_PASSWORD_MANAGER_PROPS } from '#/lib/secret-input-props';
import {
  type CredentialFormState,
  createCredentialRequest,
  updateCredentialRequest,
  validateCredentialForm
} from './credential-form';

function initialState(credential?: AgentCredentialView): CredentialFormState {
  return {
    label: credential?.label ?? '',
    description: credential?.description ?? '',
    environmentVariable: credential?.environmentVariable ?? '',
    allowedHosts: credential?.allowedHosts.join('\n') ?? '',
    secret: '',
    secretAction: credential ? 'keep' : 'replace'
  };
}

export function CredentialDialog({
  credential,
  busy,
  error,
  onClose,
  onSubmit
}: {
  credential?: AgentCredentialView;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (request: CreateAgentCredentialRequest | UpdateAgentCredentialRequest) => Promise<void>;
}) {
  const t = useT();
  const editing = Boolean(credential);
  const [state, setState] = useState(() => initialState(credential));
  const [submitted, setSubmitted] = useState(false);
  const errors = useMemo(() => validateCredentialForm(state, editing), [editing, state]);
  const set = (field: keyof CredentialFormState, value: string) =>
    setState((current) => ({ ...current, [field]: value }));
  const submit = async () => {
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    await onSubmit(editing ? updateCredentialRequest(state) : createCredentialRequest(state));
  };
  const fieldError = (field: string) => (submitted && errors[field] ? t('web.credentials.invalidField') : undefined);

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{editing ? t('web.credentials.editTitle') : t('web.credentials.createTitle')}</DialogTitle>
          <DialogDescription>{t('web.credentials.dialogDescription')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="credential-label">{t('web.credentials.label')}</Label>
            <Input
              aria-invalid={Boolean(fieldError('label'))}
              id="credential-label"
              name="credential-label"
              onChange={(event) => set('label', event.target.value)}
              value={state.label}
            />
            {fieldError('label') ? <p className="text-destructive text-xs">{fieldError('label')}</p> : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="credential-description">{t('web.credentials.description')}</Label>
            <Textarea
              id="credential-description"
              name="credential-description"
              onChange={(event) => set('description', event.target.value)}
              value={state.description}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="credential-env">{t('web.credentials.environmentVariable')}</Label>
            <Input
              aria-invalid={Boolean(fieldError('environmentVariable'))}
              className="font-mono"
              id="credential-env"
              name="credential-environment-variable"
              onChange={(event) => set('environmentVariable', event.target.value)}
              placeholder="GITHUB_TOKEN"
              spellCheck={false}
              value={state.environmentVariable}
            />
            {fieldError('environmentVariable') ? (
              <p className="text-destructive text-xs">{fieldError('environmentVariable')}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="credential-hosts">{t('web.credentials.allowedHosts')}</Label>
            <Textarea
              aria-invalid={Boolean(fieldError('allowedHosts'))}
              className="font-mono"
              id="credential-hosts"
              name="credential-allowed-hosts"
              onChange={(event) => set('allowedHosts', event.target.value)}
              placeholder="api.example.com"
              spellCheck={false}
              value={state.allowedHosts}
            />
            <p className="text-muted-foreground text-xs">{t('web.credentials.hostsHint')}</p>
            {fieldError('allowedHosts') ? (
              <p className="text-destructive text-xs">{fieldError('allowedHosts')}</p>
            ) : null}
          </div>
          {editing ? (
            <div className="grid gap-1.5">
              <Label>{t('web.credentials.secretAction')}</Label>
              <Select
                onValueChange={(value) => set('secretAction', value)}
                value={state.secretAction}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="keep">{t('web.credentials.keepSecret')}</SelectItem>
                  <SelectItem value="replace">{t('web.credentials.replaceSecret')}</SelectItem>
                  <SelectItem value="remove">{t('web.credentials.removeSecret')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {state.secretAction === 'replace' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="credential-secret">{t('web.credentials.secret')}</Label>
              <Input
                {...SECRET_INPUT_PASSWORD_MANAGER_PROPS}
                aria-invalid={Boolean(fieldError('secret'))}
                id="credential-secret"
                name="credential-secret"
                onChange={(event) => set('secret', event.target.value)}
                type="password"
                value={state.secret}
              />
              <p className="text-muted-foreground text-xs">{t('web.credentials.secretHint')}</p>
              {fieldError('secret') ? <p className="text-destructive text-xs">{fieldError('secret')}</p> : null}
            </div>
          ) : null}
          {error ? (
            <p
              aria-live="polite"
              className="text-destructive text-sm"
            >
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            onClick={onClose}
            variant="outline"
          >
            {t('web.common.cancel')}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void submit()}
          >
            {editing ? t('web.common.save') : t('web.credentials.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
