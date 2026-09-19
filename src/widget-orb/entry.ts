// Entry of public/widget-orb.js (see vite.widget-orb.config.ts).
//
// The public widget is plain JS, so it drives thinking-orbs' framework-free
// engine directly — the same geometry and painter the React <ThinkingOrb>
// uses, without React. widget.js lazy-loads this file and calls
// window.FounderOSWidgetOrb.mount(canvas, props).
//
// Mirrors the React component's behaviour: DPR capped at 2, one shared clock
// (so orbs stay in phase), paused offscreen / in a hidden tab, and a static
// frame under prefers-reduced-motion.
import { resolvePreset, MODE_DRAWS } from "thinking-orbs/engine";
import type { OrbState } from "thinking-orbs/engine";

export interface OrbProps {
  state: OrbState;
  /** Drawn size in CSS px. The nearest tuned preset (20 or 64) supplies the
   *  dot count and speed; the engine draws it at this size. */
  size: number;
  /** true = light ink, for dark surfaces. */
  dark: boolean;
  speed?: number;
}

interface Instance {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  props: OrbProps;
  draw: (t: number) => void;
  visible: boolean;
}

const instances = new Set<Instance>();
let raf = 0;

const reduced = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function tick() {
  raf = 0;
  const now = performance.now() / 1000;
  let any = false;
  for (const i of instances) {
    if (!i.visible) continue;
    i.draw(now);
    any = true;
  }
  if (any && document.visibilityState !== "hidden" && !reduced()) raf = requestAnimationFrame(tick);
}

function kick() {
  if (!raf && !reduced()) raf = requestAnimationFrame(tick);
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "hidden") kick(); });

const io = typeof IntersectionObserver !== "undefined"
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      for (const i of instances) if (i.canvas === e.target) i.visible = e.isIntersecting;
    }
    kick();
  })
  : null;

function configure(inst: Instance) {
  const { canvas, ctx, props } = inst;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = Math.max(8, Math.round(props.size));
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = size + "px";
  canvas.style.height = size + "px";
  const { mode, speed, opts } = resolvePreset(props.state, size >= 40 ? 64 : 20);
  const paint = MODE_DRAWS[mode];
  const k = speed * (props.speed ?? 1);
  inst.draw = (t: number) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    paint(ctx, size, t * k, props.dark, opts);
  };
  // Paint immediately: a reduced-motion visitor gets this frame and no loop.
  inst.draw(reduced() ? 0.6 : performance.now() / 1000);
}

function mount(canvas: HTMLCanvasElement, props: OrbProps) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { update() {}, destroy() {} };
  const inst: Instance = { canvas, ctx, props, draw: () => {}, visible: true };
  canvas.setAttribute("role", "img");
  configure(inst);
  instances.add(inst);
  io?.observe(canvas);
  kick();
  return {
    update(next: Partial<OrbProps>) {
      const merged = { ...inst.props, ...next };
      const changed = merged.state !== inst.props.state || merged.size !== inst.props.size
        || merged.dark !== inst.props.dark || merged.speed !== inst.props.speed;
      inst.props = merged;
      if (changed) configure(inst);
      kick();
    },
    destroy() {
      instances.delete(inst);
      io?.unobserve(canvas);
    },
  };
}

(window as unknown as { FounderOSWidgetOrb: unknown }).FounderOSWidgetOrb = { mount };
