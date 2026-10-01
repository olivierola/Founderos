// Entry of public/widget-bot.js (see vite.widget-bot.config.ts).
//
// The public widget is plain JS, so it cannot render <BotAvatar> itself. This
// bundle exposes the same imperative API as the voice glow: widget.js hands it
// a host element and props, and re-renders as the agent's state changes. Built
// with preact/compat — bot-avatars only needs hooks and the JSX runtime, and
// this file lands on customers' sites.
import { h, render } from "preact";
import { BotAvatar } from "bot-avatars";

export interface BotProps {
  /** One of the 18 bodies; omitted, the name decides. */
  type?: string;
  /** The agent's name — picks the body and the animation offset. */
  name?: string;
  state?: "default" | "working" | "sleeping";
  size: number;
  color?: string | null;
  dark?: boolean;
}

const TYPES = [
  "clover", "flower", "triangle", "square", "blob", "ghost", "circle", "drop", "star",
  "droid", "mech", "alien", "hexagon", "cat", "cloud", "pill", "pebble", "puddle",
];

/** Same hash as the app's AgentIdentity, so one agent wears one body on both
 *  sides: the dashboard where it is configured and the site where it answers. */
function pick(name: string): { type: string; seed: number } {
  let x = 2166136261;
  for (let i = 0; i < name.length; i++) { x ^= name.charCodeAt(i); x = Math.imul(x, 16777619); }
  x >>>= 0;
  return { type: TYPES[x % TYPES.length], seed: ((x >>> 8) % 1000) / 1000 };
}

function view(p: BotProps) {
  const auto = pick(p.name || "agent");
  const type = p.type && TYPES.includes(p.type) ? p.type : auto.type;
  // The canvas is 1.5× the body (room for the hop): centre it in a box of
  // exactly `size` so it never pushes the header's title around.
  return h("span", {
    style: {
      position: "relative", display: "inline-block", width: `${p.size}px`, height: `${p.size}px`,
      flex: "none", verticalAlign: "middle",
    },
  }, h("span", {
    style: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", lineHeight: 0 },
  }, h(BotAvatar as any, {
    type, state: p.state || "default", size: p.size, seed: auto.seed,
    color: p.color || undefined, theme: p.dark ? "dark" : "light",
    interactive: false,
  })));
}

function mount(host: HTMLElement, props: BotProps) {
  render(view(props), host);
  return {
    update(next: BotProps) { render(view(next), host); },
    unmount() { render(null, host); },
  };
}

(window as unknown as { FounderOSWidgetBot: unknown }).FounderOSWidgetBot = { mount };
