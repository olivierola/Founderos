import { useCallback, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

// Live (streaming) speech-to-text. Captures raw PCM from the mic, streams it to
// the deepgram-stream edge WebSocket (which proxies Deepgram, keeping the key
// server-side), and emits the transcript AS YOU SPEAK. `onText` receives the
// full dictated text for the current session (finals + current interim); it
// resets on each start(), so the caller composes it with its own baseline.
// Shared by every chat composer so dictation behaves the same everywhere.

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

export function useDictation(onText: (dictated: string) => void) {
  const [recording, setRecording] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The live mic stream, exposed so the composer's voice glow (voice-glow)
  // reacts to the very audio being transcribed — no second mic capture.
  const [stream, setStream] = useState<MediaStream | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const finalsRef = useRef<string[]>([]);
  const readyRef = useRef(false);

  const teardownAudio = useCallback(() => {
    try { processorRef.current?.disconnect(); } catch { /* noop */ }
    try { sourceRef.current?.disconnect(); } catch { /* noop */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try { ctxRef.current?.close(); } catch { /* noop */ }
    processorRef.current = null; sourceRef.current = null; streamRef.current = null; ctxRef.current = null;
    setLevel(0);
    setStream(null);
  }, []);

  const stop = useCallback(() => {
    setRecording(false);
    readyRef.current = false;
    teardownAudio();
    const ws = wsRef.current;
    if (ws) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send("CloseStream"); } catch { /* noop */ }
      // Give Deepgram a moment to flush the final transcript before closing.
      setTimeout(() => { try { ws.close(); } catch { /* noop */ } }, 900);
      wsRef.current = null;
    }
  }, [teardownAudio]);

  const start = useCallback(async () => {
    setError(null);
    finalsRef.current = [];
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      setError("Dictée non supportée par ce navigateur");
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
    setStream(stream);

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
    // A failed connection used to leave the mic open (and, now, the glow lit).
    ws.onerror = () => { setError("Connexion dictée échouée"); setConnecting(false); teardownAudio(); };
    ws.onclose = () => { readyRef.current = false; };
    ws.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
      if (!msg) return;
      if (msg.type === "ready") { readyRef.current = true; return; }
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      const t: string = (alt.transcript ?? "").trim();
      if (msg.is_final) {
        if (t) finalsRef.current.push(t);
        onText(finalsRef.current.join(" "));
      } else {
        onText([...finalsRef.current, t].filter(Boolean).join(" "));
      }
    };

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      // Mic level for the visualizer.
      let sum = 0;
      for (let i = 0; i < input.length; i += 8) sum += input[i] * input[i];
      setLevel(Math.min(1, Math.sqrt(sum / (input.length / 8)) * 3.2));
      if (readyRef.current && ws.readyState === WebSocket.OPEN) ws.send(floatToInt16(input));
    };
    // A muted gain keeps the processor pulling audio without echoing the mic.
    const mute = ctx.createGain(); mute.gain.value = 0;
    source.connect(processor); processor.connect(mute); mute.connect(ctx.destination);
  }, [onText, teardownAudio]);

  const toggle = useCallback(() => { if (recording || connecting) stop(); else void start(); }, [recording, connecting, start, stop]);

  return { recording, connecting, level, error, stream, start, stop, toggle };
}
