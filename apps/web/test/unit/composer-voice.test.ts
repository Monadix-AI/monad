import { expect, test } from 'bun:test';

import { collectStoppedMediaRecorderAudio } from '../../src/features/session/use-composer-voice';

test('composer voice waits for the final MediaRecorder chunk after stop before transcribing', async () => {
  const chunksRef = { current: [] as Blob[] };
  const audioPromise = collectStoppedMediaRecorderAudio(chunksRef, 'audio/webm');

  setTimeout(() => {
    chunksRef.current.push(new Blob(['final audio'], { type: 'audio/webm' }));
  }, 75);

  const audio = await audioPromise;

  expect(audio.size).toBeGreaterThan(0);
  expect(audio.type).toBe('audio/webm');
});
