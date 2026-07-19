import { t } from './i18n.ts';
import { ask } from './init-flow.ts';

export async function confirmInsecureRemoteAccess(
  skipConfirm: boolean,
  prompt: (question: string) => Promise<string> = ask
): Promise<boolean> {
  if (skipConfirm) return true;
  return /^y$/i.test(await prompt(`${t('cli.pair.httpConfirm')} [y/N] `));
}
