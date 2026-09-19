import type { ReactNode } from "react";
import { VoiceBeam } from "voice-glow";
import { useThemeMode } from "@/lib/theme-context";

/**
 * The agents' chat composer frame: the composer card wrapped in voice-glow's
 * <VoiceBeam>, exactly as the library is meant to be used —
 *
 *   <VoiceBeam stream={mic.stream}><ChatInput /></VoiceBeam>
 *
 * - At rest the beam keeps the library's soft breathing presence along the
 *   bottom edge: it is part of the composer, not an effect that shows up
 *   only now and then.
 * - While dictating it follows the mic stream being transcribed (the stream
 *   comes from useDictation, so the mic is opened once, for Deepgram).
 * - While the mic opens or the agent works it gathers into the travelling
 *   "processing" beam.
 *
 * One adjustment to the library: its wrapper clips its content
 * (overflow: hidden), and the composers' @ / slash / model menus open OUTSIDE
 * the card. The wrapper is let overflow, and the glow layers are clipped to
 * the card's rounded box instead — same picture, menus intact.
 */
export function VoiceComposer({
  stream,
  processing = false,
  radius,
  children,
  className,
  idle,
  reach,
}: {
  stream: MediaStream | null;
  processing?: boolean;
  /** The wrapped card's border radius, in px. */
  radius: number;
  children: ReactNode;
  className?: string;
  /** voice-glow's resting presence, 0–1 (library default 0.23). */
  idle?: number;
  /** voice-glow's height gain at full level (library default 1.2). */
  reach?: number;
}) {
  const mode = useThemeMode();
  const dark = mode === "dark"
    || (typeof document !== "undefined" && document.documentElement.classList.contains("dark"));
  const listening = !!stream;
  const clip = `inset(0 round ${radius}px)`;

  return (
    <VoiceBeam
      stream={listening ? stream : null}
      processing={processing && !listening}
      theme={dark ? "dark" : "light"}
      borderRadius={radius}
      // The dictation stream keeps echo cancellation + noise suppression on
      // (Deepgram wants it clean), which flattens the dynamics — give the
      // glow back some gain.
      sensitivity={4.2}
      idle={idle}
      reach={reach}
      className={className}
      style={{ width: "100%" }}
      css={`
[data-voice-beam="{id}"] { overflow: visible !important; }
[data-voice-beam="{id}"]::before,
[data-voice-beam="{id}"]::after,
[data-voice-beam="{id}"] [data-voice-beam-bloom],
[data-voice-beam="{id}"] [data-voice-beam-warp],
[data-voice-beam="{id}"] [data-voice-beam-band],
[data-voice-beam="{id}"] [data-voice-beam-core] { clip-path: ${clip}; pointer-events: none; }
`}
    >
      {children}
    </VoiceBeam>
  );
}
