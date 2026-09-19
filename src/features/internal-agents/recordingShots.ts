// Vignettes de démonstration : signer un chemin à l'affichage — correctif FOS-04.
//
// Le bucket `skill-recordings` était public : ses captures — l'écran d'un
// opérateur pendant qu'il manipule ses vrais outils — étaient lisibles par
// quiconque connaissait une URL. Il est privé depuis la migration 0241, et
// `skill_recording_events.screenshot_url` porte désormais un CHEMIN
// (`<recording_id>/0007.jpg`) plutôt qu'une URL complète.
//
// Ce module fait la conversion chemin → URL signée, avec deux précautions :
//   - il tolère les valeurs héritées (URL publique complète écrite avant 0241),
//     dont il extrait le chemin ;
//   - il met les URL signées en cache, parce qu'une timeline affiche des
//     dizaines de vignettes et qu'une signature par image ferait autant
//     d'allers-retours.

import { supabase } from "@/lib/supabase";

const BUCKET = "skill-recordings";
/** Durée de validité demandée. Une timeline se consulte, elle ne se veille pas. */
const TTL_SECONDS = 60 * 60;
/** On resigne un peu avant l'expiration réelle, pour éviter l'image cassée. */
const REFRESH_BEFORE_MS = 5 * 60 * 1000;

const cache = new Map<string, { url: string; expiresAt: number }>();

/**
 * Réduit une valeur stockée à un chemin dans le bucket.
 * Accepte le chemin nu (la forme écrite depuis 0241) comme l'URL complète des
 * lignes antérieures.
 */
export function toStoragePath(stored: string | null | undefined): string | null {
  const raw = String(stored ?? "").trim();
  if (!raw) return null;
  const marker = `/storage/v1/object/`;
  const at = raw.indexOf(marker);
  if (at === -1) return raw.replace(/^\/+/, "");
  // …/object/public/skill-recordings/<chemin>  ou  …/object/sign/skill-recordings/<chemin>?token=…
  const after = raw.slice(at + marker.length);
  const cut = after.indexOf(`${BUCKET}/`);
  if (cut === -1) return null;
  return after.slice(cut + BUCKET.length + 1).split("?")[0];
}

/** URL signée pour une vignette, ou null si le chemin est vide ou refusé. */
export async function signShot(stored: string | null | undefined): Promise<string | null> {
  const path = toStoragePath(stored);
  if (!path) return null;

  const hit = cache.get(path);
  if (hit && hit.expiresAt - REFRESH_BEFORE_MS > Date.now()) return hit.url;

  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, TTL_SECONDS);
  // Un refus est le comportement attendu quand la vignette appartient à un autre
  // workspace : on n'affiche rien, on ne signale pas d'erreur à l'utilisateur.
  if (error || !data?.signedUrl) return null;

  cache.set(path, { url: data.signedUrl, expiresAt: Date.now() + TTL_SECONDS * 1000 });
  return data.signedUrl;
}

/** Signe un lot de vignettes en une passe, en dédoublonnant les chemins. */
export async function signShots(
  stored: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const paths = [...new Set(stored.map(toStoragePath).filter((p): p is string => !!p))];
  const out = new Map<string, string>();
  await Promise.all(
    paths.map(async (p) => {
      const url = await signShot(p);
      if (url) out.set(p, url);
    }),
  );
  return out;
}
