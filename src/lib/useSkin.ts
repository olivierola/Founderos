import { useCallback, useEffect, useState } from "react";

/**
 * La peau de l'interface : le système visuel du produit, ou celui d'Apple.
 *
 * Deux systèmes complets cohabitent, et c'est délibéré. Le module de suivi a
 * été dessiné sur les tokens de Plane — gris froids à 201°, corps de 13,
 * densité forte. Les HIG d'Apple posent l'inverse : corps de 17, cibles de
 * 44 points, matériaux translucides, beaucoup d'air. Écraser l'un par l'autre
 * laisserait des centaines d'écrans réglés pour un système qui n'existe plus,
 * et la casse ne se verrait qu'écran par écran, pendant des semaines.
 *
 * D'où un ATTRIBUT sur `<html>` plutôt qu'une réécriture : `data-skin="apple"`
 * active la feuille des HIG, son absence rend la peau d'origine. La bascule
 * est instantanée et se défait aussi vite.
 *
 * Le choix est retenu par navigateur, pas en base : c'est un essai en cours,
 * pas une décision d'équipe. Le jour où l'une des deux gagne, cette bascule
 * disparaît et les tokens gagnants deviennent les seuls.
 */

export type Skin = "founderos" | "apple";

const STORAGE_KEY = "fos-skin";

function read(): Skin {
  try {
    // Apple par DÉFAUT : c'est le système visuel retenu. L'ancienne peau reste
    // installée pour comparer, mais elle ne s'affiche que si on la demande.
    return localStorage.getItem(STORAGE_KEY) === "founderos" ? "founderos" : "apple";
  } catch {
    // Navigation privée, stockage bloqué : on sert le système retenu.
    return "apple";
  }
}

function paint(skin: Skin) {
  const root = document.documentElement;
  if (skin === "apple") root.setAttribute("data-skin", "apple");
  else root.removeAttribute("data-skin");
}

/**
 * À appeler AVANT le premier rendu, depuis `main.tsx`.
 *
 * Pas dans un effet : entre le rendu initial et l'application de la peau,
 * l'écran afficherait l'autre système pendant une image, ce qui se voit comme
 * un défaut de chargement.
 */
export function applySkinNow(): void {
  paint(read());
}

export function useSkin() {
  const [skin, setSkinState] = useState<Skin>(read);

  useEffect(() => { paint(skin); }, [skin]);

  const setSkin = useCallback((next: Skin) => {
    setSkinState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* idem */ }
  }, []);

  const toggle = useCallback(() => {
    setSkin(skin === "apple" ? "founderos" : "apple");
  }, [skin, setSkin]);

  return { skin, setSkin, toggle };
}
