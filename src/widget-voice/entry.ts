// Entry of public/widget-voice.js (see vite.widget-voice.config.ts).
//
// The public widget is plain JS, so it can't render <VoiceBeam> itself. This
// bundle exposes a tiny imperative API on window: widget.js hands it a host
// element and props, and re-renders it as the dictation / thinking state
// changes. Like the app's ComposerVoiceGlow, the beam is an overlay over the
// composer (pointer-events off), never a wrapper around it.
import { h, render } from "preact";
import { VoiceBeam } from "voice-glow";

export interface VoiceGlowProps {
  stream: MediaStream | null;
  processing: boolean;
  dark: boolean;
  radius: number;
  pill: boolean;
  /** voice-glow colorVariant: colorful | mono | ocean | sunset | forest | candy | ice | gold */
  palette?: string;
  /** Keep the beam lit at rest (the library's idle breathing), as a
   *  permanent part of the composer rather than only while voice is heard. */
  always?: boolean;
}

function view(p: VoiceGlowProps) {
  const listening = !!p.stream;
  // The component is typed for React; under preact/compat it is the same
  // function, so hand it to h() untyped.
  return h(VoiceBeam as any, {
    stream: listening ? p.stream : null,
    processing: p.processing && !listening,
    active: !!p.always || listening || p.processing,
    type: p.pill ? "pill" : "default",
    theme: p.dark ? "dark" : "light",
    colorVariant: p.palette || "colorful",
    borderRadius: p.radius,
    sensitivity: 3.6,
    style: { position: "absolute", inset: 0, width: "100%", height: "100%" },
  }, h("div", { style: { width: "100%", height: "100%", borderRadius: p.radius } }));
}

function mount(host: HTMLElement, props: VoiceGlowProps) {
  render(view(props), host);
  return {
    update(next: VoiceGlowProps) { render(view(next), host); },
    unmount() { render(null, host); },
  };
}

(window as unknown as { FounderOSWidgetVoice: unknown }).FounderOSWidgetVoice = { mount };
