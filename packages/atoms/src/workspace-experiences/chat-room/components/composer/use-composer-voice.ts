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

const VOICE_SILENCE_STOP_MS = 1600;
const VOICE_NO_SPEECH_CANCEL_MS = 8000;
const VOICE_HARD_STOP_MS = 60_000;
const VOICE_MEDIA_RECORDER_TIMESLICE_MS = 250;
const VOICE_RMS_THRESHOLD = 0.035;

export function useComposerVoice({ cancelSignal, onVoiceText, voice }: ComposerVoiceOptions): {
  listening: boolean;
  toggleVoice: () => Promise<void>;
  voiceActive: boolean;
  voiceAvailable: boolean;
  voiceBusy: boolean;
  voiceDisabledReason: string | undefined;
  voiceModelConfigured: boolean;
} {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
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
      ? 'Cleaning up transcript.'
      : !voiceAvailable
        ? 'Voice input is not supported in this browser.'
        : !onVoiceText
          ? 'Voice input is unavailable here.'
          : undefined;

  const stopMediaRecorder = useCallback((): void => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    try {
      recorder.requestData();
    } catch {}
    recorder.stop();
  }, []);

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
        let lastSpeechAt = performance.now();
        const tick = (): void => {
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const value of samples) {
            const centered = (value - 128) / 128;
            sum += centered * centered;
          }
          const rms = Math.sqrt(sum / samples.length);
          const now = performance.now();
          if (rms >= VOICE_RMS_THRESHOLD) {
            voiceDetectedRef.current = true;
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
    [stopMediaRecorder, stopVoiceDetection]
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
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setListening(false);
        setVoiceBusy(false);
        return;
      }
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      mediaRecorderStreamRef.current = stream;
      mediaRecorderChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (voiceDiscardingRef.current) return;
        if (event.data.size > 0) mediaRecorderChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        mediaRecorderRef.current = null;
        mediaRecorderChunksRef.current = [];
        setListening(false);
        setVoiceBusy(false);
        stopVoiceDetection();
        stopMediaRecorderStream();
      };
      recorder.onstop = () => {
        const discarded = voiceDiscardingRef.current;
        voiceDiscardingRef.current = false;
        const chunks = mediaRecorderChunksRef.current;
        const mediaType = recorder.mimeType || chunks[0]?.type || 'audio/webm';
        const audio = new Blob(chunks, { type: mediaType });
        mediaRecorderRef.current = null;
        mediaRecorderChunksRef.current = [];
        stopVoiceDetection();
        stopMediaRecorderStream();
        setListening(false);
        if (discarded) return;
        if (voiceStoppedForNoSpeechRef.current && !voiceDetectedRef.current) {
          voiceStoppedForNoSpeechRef.current = false;
          return;
        }
        if (audio.size === 0) return;
        setVoiceBusy(true);
        const epoch = voiceEpochRef.current;
        voice
          .transcribeAudio?.(audio)
          .then((text) => {
            if (voiceEpochRef.current !== epoch) return;
            const trimmed = text.trim();
            if (trimmed) onVoiceText(trimmed);
          })
          .catch(() => {})
          .finally(() => {
            if (voiceEpochRef.current === epoch) setVoiceBusy(false);
          });
      };
      setListening(true);
      startVoiceDetection(stream);
      recorder.start(VOICE_MEDIA_RECORDER_TIMESLICE_MS);
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
      if (trimmed) onVoiceText(trimmed);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, [
    listening,
    modelTranscriptionAvailable,
    onVoiceText,
    startVoiceDetection,
    stopMediaRecorder,
    stopMediaRecorderStream,
    stopVoiceDetection,
    voice,
    voiceAvailable,
    voiceDisabledReason
  ]);

  useEffect(() => {
    if (!cancelSignal) return;
    voiceEpochRef.current += 1;
    voiceDiscardingRef.current = true;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    mediaRecorderChunksRef.current = [];
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    stopVoiceDetection();
    stopMediaRecorderStream();
    setListening(false);
    setVoiceBusy(false);
  }, [cancelSignal, stopMediaRecorderStream, stopVoiceDetection]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      stopVoiceDetection();
      mediaRecorderStreamRef.current?.getTracks().forEach((track) => {
        track.stop();
      });
      mediaRecorderStreamRef.current = null;
    };
  }, [stopVoiceDetection]);

  return { listening, toggleVoice, voiceActive, voiceAvailable, voiceBusy, voiceDisabledReason, voiceModelConfigured };
}
