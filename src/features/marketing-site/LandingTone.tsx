import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/* ── The page's background is a single plane, not a stack of bands ──────────
   Every section on the landing page is transparent. Behind all of them sits
   one fixed layer whose colour is eased from tone to tone as you scroll, so
   the canvas shifts *underneath* the content instead of hard-cutting at each
   section boundary. That transition is the whole effect: two sections that
   share a tone look continuous, and the one that changes reads as a room you
   walked into rather than a strip that was pasted on.                        */

/* Five grounds, all pulled towards the accent's own hue rather than borrowed
   from anywhere — they are the app's own carbon skin, so the marketing page and
   the product it sells sit on the same ramp of neutrals. That is what keeps the page from reading as a generic dark
   template: the room is the same colour family as the brand.

   The two light tones exist so the page can open a window in the middle of the
   dark. A section using one MUST set its own dark ink; the canvas only paints
   the ground behind it. */
export const TONES = {
  /* The resting tone: carbon background (7%). */
  slate: "#121212",
  /* The deep end, for a figure or a photograph that has to carry the eye. */
  ink: "#080808",
  /* One step up from slate, for the panels-on-panels sections. */
  raised: "#1A1A1A",
  /* Paper. The hero's ground, and the only pure white on the ramp: the page
     opens on it, so it has to read as the sheet the rest is printed on rather
     than as one more grey. */
  paper: "#FFFFFF",
  /* Carbon foreground, used as a ground — the light interlude. */
  bone: "#F5F5F5",
  /* One step deeper than bone, so two light sections do not run together. */
  sand: "#E0E0E0",
} as const;

export type Tone = keyof typeof TONES;

/** Which tones need light ink on top. The nav reads this to flip its palette. */
export const TONE_IS_DARK: Record<Tone, boolean> = {
  slate: true,
  ink: true,
  raised: true,
  paper: false,
  bone: false,
  sand: false,
};

/* ── Publishing the current tone ────────────────────────────────────────────
   The nav has to repaint with the canvas, and it is mounted *outside* the
   ToneCanvas — it belongs to the viewport, not to the scroll. So the tone goes
   through a module-level store rather than through the context below: a
   provider cannot reach a sibling, and hoisting the canvas around the nav would
   put a `fixed` element inside the thing it is supposed to float over.

   The default is a light tone, and ToneCanvas restores it on unmount. The
   interior pages (`.amp-light`) mount no canvas at all, so without that reset a
   dark tone from the page you just left would follow you onto a white one. */
const DEFAULT_TONE: Tone = "paper";

let currentTone: Tone = DEFAULT_TONE;
const toneListeners = new Set<() => void>();

function publishTone(tone: Tone) {
  if (tone === currentTone) return;
  currentTone = tone;
  toneListeners.forEach((l) => l());
}

export function useCurrentTone(): Tone {
  return useSyncExternalStore(
    (cb) => {
      toneListeners.add(cb);
      return () => toneListeners.delete(cb);
    },
    () => currentTone,
    () => DEFAULT_TONE,
  );
}

const ToneContext = createContext<(tone: Tone) => void>(() => {});

export function ToneCanvas({ children, initial = "slate" }: { children: ReactNode; initial?: Tone }) {
  const [tone, setTone] = useState<Tone>(initial);

  // The root element carries the same colour so overscroll (and the mobile
  // address-bar area) never flashes a tone the page is not currently on.
  //
  // `body` has to be cleared as well, and that is not housekeeping: the landing
  // skin paints it opaque (`html.amp-root, html.amp-root body`), and a body
  // background paints *after* the negative-z-index layer below it — so an
  // opaque body hides this canvas outright. It went unnoticed while every tone
  // was within a few percent of the body's own near-black; the moment the hero
  // asked for white it was the only thing you could see.
  useEffect(() => {
    document.documentElement.style.backgroundColor = TONES[tone];
    document.body.style.backgroundColor = "transparent";
    publishTone(tone);
    return () => {
      document.documentElement.style.removeProperty("background-color");
      document.body.style.removeProperty("background-color");
    };
  }, [tone]);

  // Separate from the effect above so it runs on unmount only, not on every
  // tone change — the cleanup of a [tone]-keyed effect fires on both.
  useEffect(() => () => publishTone(DEFAULT_TONE), []);

  return (
    <ToneContext.Provider value={setTone}>
      <div
        aria-hidden
        className="fixed inset-0 -z-10 transition-colors duration-[900ms] ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none"
        style={{ backgroundColor: TONES[tone] }}
      />
      {children}
    </ToneContext.Provider>
  );
}

/* A section that claims the canvas while it is the one you are reading. The
   trigger is a thin band across the middle of the viewport rather than the
   section's own edges: with edge triggers two sections are in view at once for
   most of a scroll and the colour ping-pongs. */
export function ToneSection({
  tone,
  children,
  className,
  id,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const setTone = useContext(ToneContext);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setTone(tone);
      },
      { rootMargin: "-48% 0px -48% 0px", threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [setTone, tone]);

  return (
    <section ref={ref} id={id} className={cn("relative", className)}>
      {children}
    </section>
  );
}
