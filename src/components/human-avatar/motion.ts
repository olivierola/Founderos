import type { Mouth } from "@/lib/human-avatar-look";

// How a person moves, apart from how it is drawn: the 3D engine (engine.ts)
// and the flat one (flat.ts, for browsers without WebGL) both read the same
// pose, so the two behave alike — they breathe, blink, look round, follow the
// pointer, wave when poked, type while working and doze while asleep.

export type HumanState = "default" | "working" | "sleeping";

export interface Pose {
  /** −1…1, the chest swelling. */
  breath: number;
  yaw: number;
  pitch: number;
  roll: number;
  /** 1 open, 0.1 shut. */
  lid: number;
  /** How far the brows rise (surprise) or fall (focus). */
  brow: number;
  mouth: Mouth | "o";
  /** 0…1, the laptop out and the hands on it. */
  work: number;
  /** The tap of each hand on the keys. */
  typing: [number, number];
  /** 0…1, the waving arm raised; `wave` is its swing. */
  armUp: number;
  wave: number;
  /** The little hop that goes with a poke, in head units. */
  hop: number;
}

export const POKE_TIME = 1.7;

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const approach = (from: number, to: number, rate: number, dt: number) => from + (to - from) * (1 - Math.exp(-rate * dt));

export class Motion {
  private time: number;
  private blinkAt = 1 + Math.random() * 2;
  private blinkStart = -1;
  private glanceAt = 2 + Math.random() * 3;
  private glance = { yaw: 0, pitch: 0 };
  private waveAt = 9 + Math.random() * 10;
  private pokeStart = -10;
  private hopping = false;
  private yaw = 0;
  private pitch = 0;
  private roll = 0;
  private work = 0;

  constructor(offset: number) {
    this.time = offset * 20;
  }

  /** A wave and a hop — what a click does. False while one is still playing. */
  poke(): boolean {
    if (this.time - this.pokeStart < POKE_TIME) return false;
    this.pokeStart = this.time;
    this.hopping = true;
    return true;
  }

  /** True while something is playing that deserves every frame. */
  get busy(): boolean {
    return this.time - this.pokeStart < POKE_TIME;
  }

  /**
   * Advances by `dt` seconds. `follow` is where the pointer would turn the
   * head, or null when it is too far; `frozen` draws the state's still pose.
   */
  step(dt: number, frozen: boolean, state: HumanState, mouth: Mouth, follow: { yaw: number; pitch: number } | null): Pose {
    this.time += dt;
    const t = this.time;

    let yaw = 0, pitch = 0, roll = 0;
    if (follow && !frozen && state !== "sleeping") {
      ({ yaw, pitch } = follow);
    } else if (!frozen) {
      if (t > this.glanceAt) {
        this.glanceAt = t + 2.5 + Math.random() * 4;
        const away = Math.random() < 0.45;
        this.glance = away ? { yaw: (Math.random() - 0.5) * 0.7, pitch: (Math.random() - 0.5) * 0.2 } : { yaw: 0, pitch: 0 };
      }
      ({ yaw, pitch } = this.glance);
    }
    if (state === "working") { pitch = 0.2 + Math.sin(t * 1.7) * 0.03; yaw = yaw * 0.3 + Math.sin(t * 0.6) * 0.08; }
    if (state === "sleeping") { pitch = 0.32; roll = 0.22; yaw = 0; }
    const step = frozen ? 1 : dt;
    const rate = frozen ? 1e3 : 7;
    this.yaw = approach(this.yaw, yaw, rate, step);
    this.pitch = approach(this.pitch, pitch, rate, step);
    this.roll = approach(this.roll, roll, rate * 0.5, step);

    // A wave now and then while idle, the way a bot jumps now and then.
    if (!frozen && state === "default" && t > this.waveAt) {
      this.waveAt = t + 14 + Math.random() * 14;
      if (t - this.pokeStart > POKE_TIME) { this.pokeStart = t; this.hopping = false; }
    }
    const p = t - this.pokeStart;
    const poking = p >= 0 && p < POKE_TIME;

    if (!frozen && t > this.blinkAt) { this.blinkStart = t; this.blinkAt = t + 2 + Math.random() * 3.5; }
    const b = t - this.blinkStart;
    const lid = state === "sleeping" ? 0.1 : b >= 0 && b < 0.15 ? 1 - Math.sin((b / 0.15) * Math.PI) * 0.9 : 1;

    this.work = frozen ? (state === "working" ? 1 : 0) : approach(this.work, state === "working" ? 1 : 0, 5, dt);

    return {
      breath: frozen ? 0 : Math.sin(t * (state === "sleeping" ? 1.2 : 2.1)),
      yaw: this.yaw,
      pitch: this.pitch,
      roll: this.roll,
      lid,
      brow: (poking ? 0.06 * Math.sin((Math.min(1, p / 0.3) * Math.PI) / 2) : 0) - (state === "working" ? 0.03 : 0),
      mouth: state === "sleeping" ? "o" : poking ? "grin" : state === "working" ? "neutral" : mouth,
      work: ease(this.work),
      typing: [Math.sin(t * 16) * 0.07, Math.sin(t * 16 + 2.1) * 0.07],
      armUp: poking ? ease(p / 0.3) * (1 - ease((p - (POKE_TIME - 0.4)) / 0.4)) : 0,
      wave: Math.sin(p * 13) * 0.28,
      hop: this.hopping && p >= 0 && p < 0.5 ? Math.sin((p / 0.5) * Math.PI) * 0.18 : 0,
    };
  }
}

/** Where the pointer turns the head, from the avatar's box; null when it is far. */
export function followTarget(rect: DOMRect, x: number, y: number): { yaw: number; pitch: number } | null {
  if (rect.width <= 0 || x < -1e4) return null;
  const dx = (x - (rect.left + rect.width / 2)) / rect.width;
  const dy = (y - (rect.top + rect.height * 0.4)) / rect.height;
  if (Math.hypot(dx, dy) >= 3.5) return null;
  return { yaw: Math.min(0.55, Math.max(-0.55, dx * 0.55)), pitch: Math.min(0.3, Math.max(-0.3, dy * 0.4)) };
}
