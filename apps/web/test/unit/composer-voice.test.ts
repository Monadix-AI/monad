import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const readSource = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('composer voice input records audio for backend transcription when a transcription model is configured', () => {
  const shell = readSource('features/session/ComposerShell.tsx');
  const hook = readSource('features/session/use-composer-voice.ts');

  expect(hook).toContain('voice?.transcribeAudio && modelTranscriptionAvailable');
  expect(hook).toContain('Voice input requires default and transcription models.');
  expect(hook).toContain('new MediaRecorder(stream)');
  expect(hook).toContain('.transcribeAudio?.(audio)');
  expect(hook).toContain('VOICE_SILENCE_STOP_MS');
  expect(hook).toContain('VOICE_NO_SPEECH_CANCEL_MS');
  expect(hook).toContain('VOICE_HARD_STOP_MS');
  expect(hook).toContain('requestAnimationFrame(tick)');
  expect(shell).toContain('disabled={disabled || voiceActive}');
  expect(shell).toContain('onBeforeInputCapture');
  expect(shell).toContain('Cleaning up transcript');
  expect(shell).not.toContain('disabled={!onVoiceText || !voiceAvailable}');
});

test('voice input requires both a default model and transcription model role', () => {
  const appShell = readSource('features/shell/AppShell.tsx');
  const workplaceComposer = readSource('features/workplace/Composer.tsx');

  expect(appShell).toContain('modelRoles?.transcription && defaultProfile?.routes.chat.provider');
  expect(workplaceComposer).toContain('modelRoles?.transcription && defaultProfile?.routes.chat.provider');
  expect(appShell).not.toContain('modelRoles?.transcription && modelRoles.fast');
  expect(workplaceComposer).not.toContain('modelRoles?.transcription && modelRoles.fast');
});
