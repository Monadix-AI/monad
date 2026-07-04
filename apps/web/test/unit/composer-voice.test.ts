import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const readSource = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const readWorkspaceSource = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');

test('composer voice input records audio for backend transcription when a transcription model is configured', () => {
  const shell = readSource('features/session/ComposerShell.tsx');
  const hook = readSource('features/session/use-composer-voice.ts');
  const composerUi = readWorkspaceSource('packages/ui/src/components/Composer.tsx');

  expect(hook).toContain('voice?.transcribeAudio && modelTranscriptionAvailable');
  expect(hook).toContain(
    'const voiceAvailable = voice?.transcribeAudio ? modelTranscriptionAvailable : speechRecognitionAvailable;'
  );
  expect(hook).toContain('Voice input requires default and transcription models.');
  expect(hook).toContain('new MediaRecorder(stream)');
  expect(hook).toContain('.transcribeAudio?.(audio)');
  expect(hook).toContain('VOICE_SILENCE_STOP_MS');
  expect(hook).toContain('VOICE_NO_SPEECH_CANCEL_MS');
  expect(hook).toContain('VOICE_HARD_STOP_MS');
  expect(hook).toContain('requestAnimationFrame(tick)');
  expect(shell).toContain('disabled={disabled || voiceActive}');
  expect(composerUi).toContain('onBeforeInputCapture');
  expect(shell).toContain('ComposerVoiceButton');
  expect(shell).toContain('ComposerAccessSelect');
  expect(shell).toContain('ComposerModelSelect');
  expect(shell).toContain('ComposerContextUsagePanel');
  expect(composerUi).toContain('MagicWand02Icon');
  expect(composerUi).toContain('animate-ping');
  expect(composerUi).toContain('ComposerContextUsagePanel');
  expect(composerUi).toContain('ComposerAccessSelect');
  expect(composerUi).toContain('ComposerModelSelect');
  expect(shell).toContain('Cleaning up transcript');
  expect(shell).not.toContain('disabled={!onVoiceText || !voiceAvailable}');
});

test('voice input requires both a default model and transcription model role', () => {
  const appShell = readSource('features/shell/AppShell.tsx');

  expect(appShell).toContain('modelRoles?.transcription && defaultProfile?.routes.chat.provider');
  expect(appShell).not.toContain('modelRoles?.transcription && modelRoles.fast');
});
