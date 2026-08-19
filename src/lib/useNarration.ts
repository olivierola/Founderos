import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

// Narration HORODATÉE — la moitié "voix" de l'enregistrement de compétence.
//
// useDictation répond à « qu'a dit l'utilisateur ? » ; ici la question est
// « qu'a-t-il dit, ET QUAND ? ». C'est toute la différence : la synthèse
// rattache une phrase au geste qu'elle décrit, donc une phrase sans instant
// exact ne vaut presque rien.
//
// D'où le choix des timestamps. Un résultat final Deepgram arrive AVEC DU
// RETARD sur la parole (le temps de la stabilisation + le réseau), parfois plus
// d'une seconde. Dater le segment à sa réception le décalerait systématiquement
// après le geste qu'il annonce. On utilise donc `start` / `duration`, que
// Deepgram exprime en secondes depuis le début du flux audio, et on les ramène
// à l'origine de l'enregistrement.
//
// Le reste (capture PCM, proxy deepgram-stream) est identique à useDictation :
// même socket, même clé côté serveur.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

function floatToInt16(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

export interface NarrationSegment {
  /** Texte du segment final. */
  text: string;
  /** Début de la phrase, en ms depuis l'origine de l'enregistrement. */
  atMs: number;
  /** Durée prononcée, en ms. */
  durationMs: number;
}

export interface UseNarrationOptions {
  /**
   * Instant (epoch ms) qui sert de zéro à la timeline — typiquement
   * `Date.parse(skill_recordings.started_at)`. Peut arriver après le montage :
   * il est relu à chaque segment.
   */
  originMs: number | null;
  onSegment: (segment: NarrationSegment) => void;
}

export function useNarration({ originMs, onSegment }: UseNarrationOptions) {
  const [recording, setRecording] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [level, setLevel] = useState(0);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const readyRef = useRef(false);
  /** Epoch ms auquel le premier échantillon audio est parti — origine des `start` Deepgram. */
  const audioStartRef = useRef<number>(0);

  // Les callbacks/origines vivent dans des refs : le socket est ouvert une fois
  // et ne doit pas être recréé à chaque rendu du parent.
  const originRef = useRef<number | null>(originMs);
  const onSegmentRef = useRef(onSegment);
  useEffect(() => { originRef.current = originMs; }, [originMs]);
  useEffect(() => { onSegmentRef.current = onSegment; }, [onSegment]);

  const teardownAudio = useCallback(() => {
    try { processorRef.current?.disconnect(); } catch { /* noop */ }
    try { sourceRef.current?.disconnect(); } catch { /* noop */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try { ctxRef.current?.close(); } catch { /* noop */ }
    processorRef.current = null; sourceRef.current = null; streamRef.current = null; ctxRef.current = null;
    setLevel(0);
    setInterim("");
  }, []);

  const stop = useCallback(() => {
    setRecording(false);
    readyRef.current = false;
    teardownAudio();
    const ws = wsRef.current;
    if (ws) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send("CloseStream"); } catch { /* noop */ }
      // Laisse à Deepgram le temps d'émettre le dernier final avant fermeture.
      setTimeout(() => { try { ws.close(); } catch { /* noop */ } }, 900);
      wsRef.current = null;
    }
  }, [teardownAudio]);

  const start = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      setError("Micro non supporté par ce navigateur");
      return;
    }
    setConnecting(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setError("Accès micro refusé"); setConnecting(false); return;
    }
    streamRef.current = stream;

    const ctx = new AudioContext();
    ctxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    sourceRef.current = source;
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token ?? "";
    const wsUrl = `${SUPABASE_URL.replace(/^http/, "ws")}/functions/v1/deepgram-stream`
      + `?apikey=${encodeURIComponent(ANON)}&token=${encodeURIComponent(token)}`
      + `&sample_rate=${Math.round(ctx.sampleRate)}&encoding=linear16`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => { setConnecting(false); setRecording(true); };
    ws.onerror = () => { setError("Connexion micro échouée"); setConnecting(false); };
    ws.onclose = () => { readyRef.current = false; };
    ws.onmessage = (e) => {
      let msg: { type?: string; is_final?: boolean; start?: number; duration?: number; channel?: { alternatives?: Array<{ transcript?: string }> } };
      try { msg = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
      if (!msg) return;
      if (msg.type === "ready") { readyRef.current = true; return; }

      const text = (msg.channel?.alternatives?.[0]?.transcript ?? "").trim();
      if (!msg.is_final) { setInterim(text); return; }
      setInterim("");
      if (!text) return;

      const origin = originRef.current;
      // `start` est en secondes depuis le début du FLUX ; on le replace sur la
      // timeline de l'enregistrement. Sans origine connue, on retombe sur
      // l'instant de réception plutôt que de perdre le segment.
      const audioStart = audioStartRef.current || Date.now();
      const spokenAt = audioStart + Math.round((msg.start ?? 0) * 1000);
      const atMs = origin != null ? Math.max(0, spokenAt - origin) : Math.max(0, Date.now() - audioStart);

      onSegmentRef.current({
        text,
        atMs,
        durationMs: Math.round((msg.duration ?? 0) * 1000),
      });
    };

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i += 8) sum += input[i] * input[i];
      setLevel(Math.min(1, Math.sqrt(sum / (input.length / 8)) * 3.2));
      if (readyRef.current && ws.readyState === WebSocket.OPEN) {
        if (!audioStartRef.current) audioStartRef.current = Date.now();
        ws.send(floatToInt16(input));
      }
    };
    // Un gain muet garde le processeur alimenté sans renvoyer le micro dans les
    // haut-parleurs.
    const mute = ctx.createGain(); mute.gain.value = 0;
    source.connect(processor); processor.connect(mute); mute.connect(ctx.destination);
  }, []);

  const toggle = useCallback(() => {
    if (recording || connecting) stop(); else void start();
  }, [recording, connecting, start, stop]);

  // Le micro ne doit jamais survivre à la page qui l'a ouvert.
  useEffect(() => () => { stop(); }, [stop]);

  return { recording, connecting, level, interim, error, start, stop, toggle };
}
