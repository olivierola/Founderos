import { useEffect } from "react";

/**
 * Le relief des boutons : au survol, un bouton grossit de 2 % ; pressé, il
 * rétrécit de 10 %, puis revient avec un petit rebond au relâché.
 *
 * Posé une fois sur la coque, pour TOUS les boutons qu'elle contient —
 * présents et à venir — par délégation d'événements, plutôt que classe par
 * classe dans des centaines de composants.
 *
 * Trois choix qui le rendent sûr :
 *   · l'animation porte sur la propriété CSS `scale`, distincte de
 *     `transform` : un bouton déjà centré par un `translate`, ou tourné, garde
 *     sa transformation ;
 *   · elle passe par l'API Web Animations, et non par une `transition` : les
 *     classes Tailwind (`transition-colors`…) réécrivent `transition-property`
 *     et auraient éteint l'animation sur la moitié des boutons ;
 *   · une grande surface cliquable (une carte, une ligne pleine largeur)
 *     bouge moins : une carte entière qui s'effondre de 10 % se lit comme un
 *     bug, pas comme un clic.
 *
 * Un bouton désactivé ne bouge pas ; `data-no-press` l'exclut à la main ; et
 * rien ne bouge pour qui a demandé moins d'animations à son système.
 */
const SELECTOR = 'button, [role="button"], a[data-press], input[type="submit"], input[type="button"]';

const SMALL = { hover: 1.02, pressed: 0.9 };
const LARGE = { hover: 1.006, pressed: 0.975 };

export function usePressFeedback() {
  useEffect(() => {
    if (typeof window === "undefined" || typeof Element.prototype.animate !== "function") return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const running = new WeakMap<Element, Animation>();
    let hovered: HTMLElement | null = null;
    let held: HTMLElement | null = null;

    const target = (node: EventTarget | null): HTMLElement | null => {
      const el = (node as Element | null)?.closest?.(SELECTOR) as HTMLElement | null;
      if (!el || reduced?.matches) return null;
      if (el.matches(":disabled, [aria-disabled='true'], [data-no-press]")) return null;
      return el;
    };
    const scaleOf = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return r.width > 280 || r.height > 120 ? LARGE : SMALL;
    };

    /** Anime vers `to`, en repartant de l'échelle du moment — un clic enchaîné
     *  ne saute pas. Revenu à 1, l'animation se retire : un `scale` figé
     *  empêcherait tout autre réglage du bouton. */
    const animate = (el: HTMLElement, frames: Keyframe[], duration: number, easing: string) => {
      const from = currentScale(el);
      running.get(el)?.cancel();
      const a = el.animate([{ scale: from }, ...frames], { duration, easing, fill: "forwards" });
      running.set(el, a);
      if (frames.at(-1)?.scale === "1") {
        a.onfinish = () => { if (running.get(el) === a) { a.cancel(); running.delete(el); } };
      }
    };
    const rest = (el: HTMLElement) => (el === hovered ? String(scaleOf(el).hover) : "1");

    const hoverIn = (el: HTMLElement) => animate(el, [{ scale: String(scaleOf(el).hover) }], 160, "ease-out");
    const hoverOut = (el: HTMLElement) => { if (el !== held) animate(el, [{ scale: "1" }], 180, "ease-out"); };
    const press = (el: HTMLElement) => animate(el, [{ scale: String(scaleOf(el).pressed) }], 110, "cubic-bezier(.2,.8,.3,1)");
    const release = (el: HTMLElement) => {
      const to = rest(el);
      const over = String(Number(to) + 0.02);
      animate(el, [{ scale: over, offset: 0.6 }, { scale: to }], 260, "cubic-bezier(.3,1.3,.5,1)");
    };

    // Survol : à la souris seulement — au doigt, il n'y a pas de survol.
    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const el = target(e.target);
      if (el === hovered) return;
      if (hovered) hoverOut(hovered);
      hovered = el;
      if (el && el !== held) hoverIn(el);
    };
    const onOut = (e: PointerEvent) => {
      if (!hovered || e.pointerType !== "mouse") return;
      const to = e.relatedTarget as Node | null;
      if (to && hovered.contains(to)) return;
      const left = hovered;
      hovered = null;
      hoverOut(left);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const el = target(e.target);
      if (!el) return;
      held = el;
      press(el);
    };
    const onUp = () => {
      if (!held) return;
      const el = held;
      held = null;
      release(el);
    };
    // Au clavier (Entrée, Espace), le même geste en une fois.
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || (e.key !== "Enter" && e.key !== " ")) return;
      const el = target(e.target);
      if (!el || el !== document.activeElement) return;
      press(el);
      window.setTimeout(() => release(el), 110);
    };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("blur", onUp);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("blur", onUp);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);
}

function currentScale(el: HTMLElement): string {
  const s = getComputedStyle(el).scale;
  return !s || s === "none" ? "1" : s.split(" ")[0];
}
