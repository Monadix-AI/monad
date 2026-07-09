'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{ 0?: { transcript?: string }; isFinal?: boolean }>;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechWindow = Window &
  typeof globalThis & {
    AudioContext?: typeof AudioContext;
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    webkitAudioContext?: typeof AudioContext;
  };

type ComposerVoiceOptions = {
  cancelSignal?: number;
  onVoiceText?: (text: string) => void;
  voice?: {
    modelConfigured?: boolean;
    transcribeAudio?: (audio: Blob) => Promise<string>;
  };
};

export type ComposerVoiceDebugSnapshot = {
  audioSize?: number;
  chunkCount: number;
  discarded: boolean;
  enabled: true;
  epoch: number;
  event: string;
  lastChunkSize?: number;
  lastError?: string;
  mediaType?: string;
  mode: 'media-recorder' | 'speech-recognition';
  recorderState?: string;
  requestDataCalled: boolean;
  timestamp: string;
  transcribeStatus: 'idle' | 'pending' | 'success' | 'error' | 'skipped';
  voiceAvailable: boolean;
  voiceBusy: boolean;
  voiceDetected: boolean;
  voiceDisabledReason?: string;
  voiceLevel: number;
  voiceModelConfigured: boolean;
};

const VOICE_SILENCE_STOP_MS = 1600;
const VOICE_NO_SPEECH_CANCEL_MS = 8000;
const VOICE_HARD_STOP_MS = 60_000;
const VOICE_MEDIA_RECORDER_TIMESLICE_MS = 250;
const VOICE_FINAL_CHUNK_WAIT_MS = 350;
const VOICE_RMS_THRESHOLD = 0.035;
const VOICE_SPECTRUM_BANDS = 20;

function frequencyDataToBands(frequencyData: Uint8Array): number[] {
  return Array.from({ length: VOICE_SPECTRUM_BANDS }, (_, bandIndex) => {
    const startRatio = (bandIndex / VOICE_SPECTRUM_BANDS) ** 1.45;
    const endRatio = ((bandIndex + 1) / VOICE_SPECTRUM_BANDS) ** 1.45;
    const start = Math.floor(startRatio * frequencyData.length);
    const end = Math.max(start + 1, Math.floor(endRatio * frequencyData.length));
    let sum = 0;
    for (let index = start; index < end; index += 1) sum += frequencyData[index] ?? 0;
    return Math.min(1, Math.max(0, sum / (end - start) / 255));
  });
}

function composerVoiceDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.get('voiceDebug') === '1' || window.localStorage.getItem('monad:voice-debug') === '1';
}

function debugTimestamp(): string {
  return new Date().toLocaleTimeString(undefined, {
    fractionalSecondDigits: 3,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export async function collectStoppedMediaRecorderAudio(
  chunksRef: { current: Blob[] },
  mediaType: string
): Promise<Blob> {
  const startedAt = performance.now();
  while (chunksRef.current.length === 0 && performance.now() - startedAt < VOICE_FINAL_CHUNK_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const chunks = [...chunksRef.current];
  return new Blob(chunks, { type: mediaType || chunks[0]?.type || 'audio/webm' });
}

export function useComposerVoice({ cancelSignal, onVoiceText, voice }: ComposerVoiceOptions): {
  listening: boolean;
  toggleVoice: () => Promise<void>;
  voiceActive: boolean;
  voiceAvailable: boolean;
  voiceBusy: boolean;
  voiceDisabledReason: string | undefined;
  voiceDebug: ComposerVoiceDebugSnapshot | null;
  voiceLevel: number;
  voiceModelConfigured: boolean;
  voiceSpectrum: number[];
} {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const fallbackRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const fallbackTranscriptRef = useRef('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaRecorderStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderChunksRef = useRef<Blob[]>([]);
  const voiceAudioContextRef = useRef<AudioContext | null>(null);
  const voiceAnimationFrameRef = useRef<number | null>(null);
  const voiceHardStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceNoSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceDetectedRef = useRef(false);
  const voiceDiscardingRef = useRef(false);
  const voiceEpochRef = useRef(0);
  const voiceStoppedForNoSpeechRef = useRef(false);
  const [listening, setListening] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [voiceSpectrum, setVoiceSpectrum] = useState<number[]>([]);
  const voiceActive = listening || voiceBusy;
  const speechRecognitionAvailable =
    typeof window !== 'undefined' &&
    Boolean((window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition);
  const modelTranscriptionAvailable =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined';
  const voiceAvailable = voice?.transcribeAudio ? modelTranscriptionAvailable : speechRecognitionAvailable;
  const voiceModelConfigured = voice?.modelConfigured ?? true;
  const voiceDisabledReason = !voiceModelConfigured
    ? 'Voice input requires default and transcription models.'
    : voiceBusy
      ? 'Transcribing audio.'
      : !voiceAvailable
        ? 'Voice input is not supported in this browser.'
        : !onVoiceText
          ? 'Voice input is unavailable here.'
          : undefined;
  const [voiceDebug, setVoiceDebug] = useState<ComposerVoiceDebugSnapshot | null>(() =>
    composerVoiceDebugEnabled()
      ? {
          chunkCount: 0,
          discarded: false,
          enabled: true,
          epoch: 0,
          event: 'ready',
          mode: voice?.transcribeAudio ? 'media-recorder' : 'speech-recognition',
          recorderState: 'none',
          requestDataCalled: false,
          timestamp: debugTimestamp(),
          transcribeStatus: 'idle',
          voiceAvailable,
          voiceBusy: false,
          voiceDetected: false,
          voiceDisabledReason,
          voiceLevel: 0,
          voiceModelConfigured
        }
      : null
  );
  const updateVoiceDebug = useCallback((patch: Partial<ComposerVoiceDebugSnapshot>): void => {
    setVoiceDebug((current) => (current ? { ...current, ...patch, timestamp: debugTimestamp() } : current));
  }, []);

  const stopFallbackRecognition = useCallback((): void => {
    const recognition = fallbackRecognitionRef.current;
    fallbackRecognitionRef.current = null;
    try {
      recognition?.stop();
    } catch {
      // Best effort cleanup; some browsers throw if recognition already ended.
    }
  }, []);

  const startFallbackRecognition = useCallback((): void => {
    stopFallbackRecognition();
    fallbackTranscriptRef.current = '';
    const SpeechRecognition =
      (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      updateVoiceDebug({ event: 'fallback speech recognition unavailable' });
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    recognition.onresult = (event) => {
      let text = '';
      for (let i = 0; i < event.results.length; i += 1) {
        text += event.results[i]?.[0]?.transcript ?? '';
      }
      fallbackTranscriptRef.current = text.trim();
      updateVoiceDebug({
        event: fallbackTranscriptRef.current
          ? 'fallback speech recognition result'
          : 'fallback speech recognition empty'
      });
    };
    recognition.onerror = () => {
      updateVoiceDebug({ event: 'fallback speech recognition error' });
    };
    recognition.onend = () => {
      if (fallbackRecognitionRef.current === recognition) fallbackRecognitionRef.current = null;
    };
    fallbackRecognitionRef.current = recognition;
    try {
      recognition.start();
      updateVoiceDebug({ event: 'fallback speech recognition started' });
    } catch (error) {
      fallbackRecognitionRef.current = null;
      updateVoiceDebug({ event: 'fallback speech recognition start failed', lastError: String(error) });
    }
  }, [stopFallbackRecognition, updateVoiceDebug]);

  const stopMediaRecorder = useCallback((): void => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    updateVoiceDebug({
      event: 'stop requested',
      recorderState: recorder.state,
      requestDataCalled: true
    });
    try {
      recorder.requestData();
    } catch (error) {
      updateVoiceDebug({ event: 'requestData failed', lastError: String(error) });
    }
    recorder.stop();
  }, [updateVoiceDebug]);

  const clearVoiceTimers = useCallback((): void => {
    if (voiceHardStopTimerRef.current) {
      clearTimeout(voiceHardStopTimerRef.current);
      voiceHardStopTimerRef.current = null;
    }
    if (voiceNoSpeechTimerRef.current) {
      clearTimeout(voiceNoSpeechTimerRef.current);
      voiceNoSpeechTimerRef.current = null;
    }
  }, []);

  const stopVoiceDetection = useCallback((): void => {
    clearVoiceTimers();
    if (voiceAnimationFrameRef.current !== null) {
      cancelAnimationFrame(voiceAnimationFrameRef.current);
      voiceAnimationFrameRef.current = null;
    }
    const audioContext = voiceAudioContextRef.current;
    voiceAudioContextRef.current = null;
    setVoiceLevel(0);
    setVoiceSpectrum([]);
    void audioContext?.close().catch(() => {});
  }, [clearVoiceTimers]);

  const stopMediaRecorderStream = useCallback((): void => {
    mediaRecorderStreamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    mediaRecorderStreamRef.current = null;
  }, []);

  const startVoiceDetection = useCallback(
    (stream: MediaStream): void => {
      stopVoiceDetection();
      voiceDetectedRef.current = false;
      voiceStoppedForNoSpeechRef.current = false;
      voiceHardStopTimerRef.current = setTimeout(() => stopMediaRecorder(), VOICE_HARD_STOP_MS);
      voiceNoSpeechTimerRef.current = setTimeout(() => {
        voiceStoppedForNoSpeechRef.current = true;
        stopMediaRecorder();
      }, VOICE_NO_SPEECH_CANCEL_MS);
      const AudioContextCtor = (window as SpeechWindow).AudioContext ?? (window as SpeechWindow).webkitAudioContext;
      if (!AudioContextCtor) return;
      try {
        const audioContext = new AudioContextCtor();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        voiceAudioContextRef.current = audioContext;
        const samples = new Uint8Array(analyser.fftSize);
        const frequencyData = new Uint8Array(analyser.frequencyBinCount);
        let lastSpeechAt = performance.now();
        const tick = (): void => {
          analyser.getByteTimeDomainData(samples);
          analyser.getByteFrequencyData(frequencyData);
          let sum = 0;
          for (const value of samples) {
            const centered = (value - 128) / 128;
            sum += centered * centered;
          }
          const rms = Math.sqrt(sum / samples.length);
          const normalizedLevel = Math.min(1, Math.max(0, rms / 0.16));
          setVoiceLevel((level) => level * 0.62 + normalizedLevel * 0.38);
          const nextSpectrum = frequencyDataToBands(frequencyData);
          setVoiceSpectrum((current) =>
            nextSpectrum.map((value, index) => (current[index] ?? value) * 0.56 + value * 0.44)
          );
          const now = performance.now();
          if (rms >= VOICE_RMS_THRESHOLD) {
            voiceDetectedRef.current = true;
            updateVoiceDebug({ event: 'voice detected', voiceDetected: true });
            lastSpeechAt = now;
            if (voiceNoSpeechTimerRef.current) {
              clearTimeout(voiceNoSpeechTimerRef.current);
              voiceNoSpeechTimerRef.current = null;
            }
          } else if (voiceDetectedRef.current && now - lastSpeechAt >= VOICE_SILENCE_STOP_MS) {
            stopMediaRecorder();
            return;
          }
          voiceAnimationFrameRef.current = requestAnimationFrame(tick);
        };
        voiceAnimationFrameRef.current = requestAnimationFrame(tick);
      } catch {
        voiceAudioContextRef.current = null;
      }
    },
    [stopMediaRecorder, stopVoiceDetection, updateVoiceDebug]
  );

  const toggleVoice = useCallback(async (): Promise<void> => {
    if (listening && mediaRecorderRef.current) {
      stopMediaRecorder();
      return;
    }
    if (voiceDisabledReason) return;
    if (!onVoiceText || !voiceAvailable) return;
    if (voice?.transcribeAudio && modelTranscriptionAvailable) {
      let stream: MediaStream;
      try {
        updateVoiceDebug({
          event: 'requesting microphone',
          mode: 'media-recorder',
          transcribeStatus: 'idle'
        });
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        updateVoiceDebug({ event: 'microphone failed', lastError: 'getUserMedia failed' });
        setListening(false);
        setVoiceBusy(false);
        setVoiceLevel(0);
        setVoiceSpectrum([]);
        return;
      }
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      mediaRecorderStreamRef.current = stream;
      mediaRecorderChunksRef.current = [];
      startFallbackRecognition();
      updateVoiceDebug({
        audioSize: undefined,
        chunkCount: 0,
        discarded: false,
        epoch: voiceEpochRef.current,
        event: 'recorder ready',
        lastChunkSize: undefined,
        lastError: undefined,
        mediaType: recorder.mimeType || undefined,
        recorderState: recorder.state,
        requestDataCalled: false,
        transcribeStatus: 'idle',
        voiceDetected: false
      });
      recorder.ondataavailable = (event) => {
        if (voiceDiscardingRef.current) {
          updateVoiceDebug({
            discarded: true,
            event: 'chunk discarded',
            lastChunkSize: event.data.size
          });
          return;
        }
        if (event.data.size > 0) mediaRecorderChunksRef.current.push(event.data);
        updateVoiceDebug({
          chunkCount: mediaRecorderChunksRef.current.length,
          event: 'chunk received',
          lastChunkSize: event.data.size,
          mediaType: event.data.type || recorder.mimeType || undefined
        });
      };
      recorder.onerror = () => {
        stopFallbackRecognition();
        fallbackTranscriptRef.current = '';
        updateVoiceDebug({
          event: 'recorder error',
          lastError: 'MediaRecorder error',
          recorderState: recorder.state,
          transcribeStatus: 'error'
        });
        mediaRecorderRef.current = null;
        mediaRecorderChunksRef.current = [];
        setListening(false);
        setVoiceBusy(false);
        setVoiceLevel(0);
        setVoiceSpectrum([]);
        stopVoiceDetection();
        stopMediaRecorderStream();
      };
      recorder.onstop = () => {
        const discarded = voiceDiscardingRef.current;
        voiceDiscardingRef.current = false;
        const mediaType = recorder.mimeType || mediaRecorderChunksRef.current[0]?.type || 'audio/webm';
        const epoch = voiceEpochRef.current;
        mediaRecorderRef.current = null;
        updateVoiceDebug({
          chunkCount: mediaRecorderChunksRef.current.length,
          discarded,
          epoch,
          event: 'recorder stopped',
          mediaType,
          recorderState: recorder.state
        });
        stopVoiceDetection();
        stopFallbackRecognition();
        setListening(false);
        if (!discarded) setVoiceBusy(true);
        void collectStoppedMediaRecorderAudio(mediaRecorderChunksRef, mediaType)
          .then((audio) => {
            mediaRecorderChunksRef.current = [];
            stopMediaRecorderStream();
            updateVoiceDebug({
              audioSize: audio.size,
              event: 'audio collected',
              mediaType: audio.type || mediaType,
              transcribeStatus: audio.size === 0 ? 'skipped' : 'idle'
            });
            if (discarded || voiceEpochRef.current !== epoch) {
              updateVoiceDebug({
                event: discarded ? 'transcribe skipped: discarded' : 'transcribe skipped: stale epoch',
                transcribeStatus: 'skipped'
              });
              return;
            }
            voiceStoppedForNoSpeechRef.current = false;
            if (audio.size === 0) {
              updateVoiceDebug({ event: 'transcribe skipped: empty audio', transcribeStatus: 'skipped' });
              return;
            }
            updateVoiceDebug({ event: 'transcribe request starting', transcribeStatus: 'pending' });
            return voice
              .transcribeAudio?.(audio)
              .then((text) => {
                if (voiceEpochRef.current !== epoch) return;
                const trimmed = text.trim();
                const fallbackText = fallbackTranscriptRef.current.trim();
                updateVoiceDebug({
                  event: trimmed
                    ? 'transcribe success'
                    : fallbackText
                      ? 'transcribe empty result: using fallback speech recognition'
                      : 'transcribe empty result',
                  transcribeStatus: 'success'
                });
                fallbackTranscriptRef.current = '';
                if (trimmed) {
                  onVoiceText(trimmed);
                } else if (fallbackText) {
                  onVoiceText(fallbackText);
                }
              })
              .catch((error) => {
                const fallbackText = fallbackTranscriptRef.current.trim();
                updateVoiceDebug({
                  event: fallbackText ? 'transcribe failed: using fallback speech recognition' : 'transcribe failed',
                  lastError: String(error),
                  transcribeStatus: 'error'
                });
                fallbackTranscriptRef.current = '';
                if (fallbackText) onVoiceText(fallbackText);
              })
              .finally(() => {
                if (voiceEpochRef.current === epoch) setVoiceBusy(false);
              });
          })
          .catch(() => {
            mediaRecorderChunksRef.current = [];
            stopMediaRecorderStream();
            updateVoiceDebug({ event: 'audio collect failed', transcribeStatus: 'error' });
          })
          .finally(() => {
            if (voiceEpochRef.current === epoch) setVoiceBusy(false);
          });
      };
      setListening(true);
      startVoiceDetection(stream);
      recorder.start(VOICE_MEDIA_RECORDER_TIMESLICE_MS);
      updateVoiceDebug({ event: 'recorder started', recorderState: recorder.state });
      return;
    }
    if (recognitionRef.current && listening) {
      recognitionRef.current.stop();
      setListening(false);
      return;
    }
    const SpeechRecognition =
      (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    updateVoiceDebug({
      event: 'speech recognition started',
      mode: 'speech-recognition',
      transcribeStatus: 'idle'
    });
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || 'en-US';
    recognition.onresult = (event) => {
      let text = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result?.isFinal) text += result[0]?.transcript ?? '';
      }
      const trimmed = text.trim();
      updateVoiceDebug({ event: trimmed ? 'speech recognition result' : 'speech recognition empty result' });
      if (trimmed) onVoiceText(trimmed);
    };
    recognition.onerror = () => {
      updateVoiceDebug({ event: 'speech recognition error', transcribeStatus: 'error' });
      setListening(false);
    };
    recognition.onend = () => {
      updateVoiceDebug({ event: 'speech recognition ended' });
      setListening(false);
    };
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, [
    listening,
    modelTranscriptionAvailable,
    onVoiceText,
    startVoiceDetection,
    startFallbackRecognition,
    stopMediaRecorder,
    stopMediaRecorderStream,
    stopFallbackRecognition,
    stopVoiceDetection,
    voice,
    voiceAvailable,
    voiceDisabledReason,
    updateVoiceDebug
  ]);

  useEffect(() => {
    if (!cancelSignal) return;
    voiceEpochRef.current += 1;
    voiceDiscardingRef.current = true;
    updateVoiceDebug({
      discarded: true,
      epoch: voiceEpochRef.current,
      event: 'cancel signal',
      transcribeStatus: 'skipped'
    });
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    stopFallbackRecognition();
    fallbackTranscriptRef.current = '';
    mediaRecorderChunksRef.current = [];
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    stopVoiceDetection();
    stopMediaRecorderStream();
    setListening(false);
    setVoiceBusy(false);
    setVoiceLevel(0);
    setVoiceSpectrum([]);
  }, [cancelSignal, stopFallbackRecognition, stopMediaRecorderStream, stopVoiceDetection, updateVoiceDebug]);

  useEffect(() => {
    updateVoiceDebug({
      event: voiceDebug?.event ?? 'state updated',
      mode: voice?.transcribeAudio ? 'media-recorder' : 'speech-recognition',
      recorderState: mediaRecorderRef.current?.state ?? 'none',
      voiceAvailable,
      voiceBusy,
      voiceDisabledReason,
      voiceLevel,
      voiceModelConfigured
    });
  }, [
    voice?.transcribeAudio,
    voiceAvailable,
    voiceBusy,
    voiceDebug?.event,
    voiceDisabledReason,
    voiceLevel,
    voiceModelConfigured,
    updateVoiceDebug
  ]);

  useEffect(() => {
    return () => {
      updateVoiceDebug({ event: 'unmount cleanup', transcribeStatus: 'skipped' });
      recognitionRef.current?.stop();
      stopFallbackRecognition();
      fallbackTranscriptRef.current = '';
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      stopVoiceDetection();
      mediaRecorderStreamRef.current?.getTracks().forEach((track) => {
        track.stop();
      });
      mediaRecorderStreamRef.current = null;
    };
  }, [stopFallbackRecognition, stopVoiceDetection, updateVoiceDebug]);

  return {
    listening,
    toggleVoice,
    voiceActive,
    voiceAvailable,
    voiceBusy,
    voiceDisabledReason,
    voiceDebug,
    voiceLevel,
    voiceModelConfigured,
    voiceSpectrum
  };
}
