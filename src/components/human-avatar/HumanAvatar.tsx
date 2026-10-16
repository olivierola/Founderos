import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { nameHash } from "@/lib/bot-avatar-look";
import { resolveHumanLook, type HumanLook } from "@/lib/human-avatar-look";
import type { HumanHandle, HumanOptions, HumanState } from "./engine";
import { webglAvailable } from "./webgl";

// A 3D humanoid avatar on a plain 2D canvas — the drawing is done by the
// shared engine (engine.ts), fetched with three.js the first time a person is
// on screen, so pages without one never pay for it. Where the browser gives no
// WebGL, the flat renderer (flat.ts) draws the same person instead, and
// three.js is not fetched at all.

let engine: Promise<typeof import("./engine")> | null = null;
const loadEngine = () => (engine ??= import("./engine"));
let flatEngine: Promise<typeof import("./flat")> | null = null;
const loadFlat = () => (flatEngine ??= import("./flat"));

async function mount(canvas: HTMLCanvasElement, opts: HumanOptions): Promise<HumanHandle | null> {
  if (webglAvailable()) {
    const h = (await loadEngine()).mountHuman(canvas, opts);
    if (h) return h;
  }
  return (await loadFlat()).mountFlatHuman(canvas, opts);
}

export function HumanAvatar({
  look, seed, size, state = "default", interactive = true, paused, fallback = null, className, label, closeUp: framed,
}: {
  look: HumanLook;
  /** The agent's name: picks every trait the studio left open. */
  seed: string;
  size: number;
  state?: HumanState;
  /** Follows the pointer and waves on a click. */
  interactive?: boolean;
  paused?: boolean;
  /** Head and shoulders rather than the bust; by default below 48 px. */
  closeUp?: boolean;
  /** Drawn instead when the browser gives no WebGL. */
  fallback?: ReactNode;
  className?: string;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handle = useRef<HumanHandle | null>(null);
  const [failed, setFailed] = useState(false);
  const resolved = useMemo(() => resolveHumanLook(look, seed), [look, seed]);

  const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
  // Small ones are drawn at 1.5× and scaled down: antialiasing alone leaves a
  // face of a few pixels ragged.
  const px = Math.round(size * dpr * (size < 48 ? 1.5 : 1));
  const closeUp = framed ?? size < 48;

  const opts: HumanOptions = {
    look: resolved, state, paused: !!paused, interactive, closeUp,
    offset: (nameHash(seed || "agent") % 1000) / 1000,
  };
  const latest = useRef(opts);
  latest.current = opts;

  useEffect(() => {
    let alive = true;
    const canvas = canvasRef.current;
    if (canvas) {
      mount(canvas, latest.current)
        .then((h) => {
          if (!alive) { h?.dispose(); return; }
          if (h) handle.current = h;
          else setFailed(true);
        })
        .catch(() => { if (alive) setFailed(true); });
    }
    return () => {
      alive = false;
      handle.current?.dispose();
      handle.current = null;
    };
  }, []);

  useEffect(() => { handle.current?.update({ look: resolved }); }, [resolved]);
  useEffect(() => {
    handle.current?.update({ state, paused: !!paused, interactive, closeUp });
  }, [state, paused, interactive, closeUp]);
  useEffect(() => { handle.current?.resize(); }, [px]);

  if (failed) return <>{fallback}</>;
  return (
    <canvas
      ref={canvasRef}
      width={px}
      height={px}
      data-human-avatar=""
      role="img"
      aria-label={label ?? "Avatar"}
      onClick={interactive ? () => handle.current?.poke() : undefined}
      className={cn("block", className)}
      style={{ width: size, height: size }}
    />
  );
}
