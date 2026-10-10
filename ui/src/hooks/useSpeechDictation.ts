import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Dictation through the browser's own speech recognition (the Web Speech
 * API). Chrome and Edge have it, under a `webkit` name; Firefox does not, so
 * callers hide the microphone whenever `supported` is false. Nothing is sent
 * anywhere by this code: the browser does the recognition and hands back
 * text.
 */

/** The parts of the Web Speech API used here. TypeScript's DOM types do not name the webkit one. */
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike | undefined;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const speechWindow = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function describeDictationError(code: string | undefined): string | null {
  // Silence is not a fault worth a message; the button just turns off.
  if (!code || code === "no-speech" || code === "aborted") return null;
  if (code === "not-allowed" || code === "service-not-allowed") {
    return "The browser blocked the microphone. Allow it for this site to dictate.";
  }
  if (code === "audio-capture") return "No microphone was found.";
  return "Dictation stopped because the browser reported a problem. Try again.";
}

export interface SpeechDictation {
  /** The browser can dictate. Hide the microphone when it cannot. */
  supported: boolean;
  listening: boolean;
  /** A sentence to show when dictation stopped for a reason the person can fix. */
  error: string | null;
  start: () => void;
  stop: () => void;
}

/** `onText` gets each finished phrase, trimmed. */
export function useSpeechDictation(onText: (text: string) => void): SpeechDictation {
  const [supported] = useState(() => speechRecognitionConstructor() !== null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition || recognitionRef.current) return;
    const recognition = new Recognition();
    recognition.lang = typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result?.isFinal) continue;
        const text = result[0]?.transcript.trim();
        if (text) onTextRef.current(text);
      }
    };
    recognition.onerror = (event) => setError(describeDictationError(event.error));
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = recognition;
    setError(null);
    try {
      recognition.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
      setListening(false);
      setError(describeDictationError("unknown"));
    }
  }, []);

  // Stop listening when the composer goes away (a chat switch, Clippy closed).
  useEffect(
    () => () => {
      const recognition = recognitionRef.current;
      if (!recognition) return;
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.abort();
      recognitionRef.current = null;
    },
    [],
  );

  return { supported, listening, error, start, stop };
}
