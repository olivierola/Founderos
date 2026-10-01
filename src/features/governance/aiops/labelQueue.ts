// La file de validation du Labeling, lue sur les VRAIS documents.
//
// Avant, l'onglet affichait trois messages de support écrits en dur, en boucle,
// avec des confiances inventées. On y validait donc des labels sur des textes
// qui n'appartenaient à personne. Ici, les documents sortent du fichier que
// l'utilisateur a lui-même importé (bucket privé `ft-datasets`), et les labels
// proposés sortent d'un vrai appel de classification.
//
// Quand le dataset n'a pas de fichier attaché, il n'y a pas de repli inventé :
// la file le dit et reste vide.
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import type { FtDataset, LabelSet } from "./data";

/** Combien de documents on charge d'avance depuis le fichier. */
const QUEUE_SIZE = 40;
/** Garde-fou de téléchargement : on ne lit que le début d'un gros fichier. */
const MAX_BYTES = 512 * 1024;

export interface QueueDoc { id: string; text: string }

/** Champs qui, dans un JSONL, portent le plus souvent le texte à labelliser. */
const TEXT_KEYS = ["text", "content", "message", "prompt", "body", "question", "input", "document"];

function fromJsonl(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      const key = TEXT_KEYS.find((k) => typeof o[k] === "string" && (o[k] as string).trim());
      if (key) { out.push(String(o[key])); continue; }
      // Format conversationnel : on prend le premier tour utilisateur.
      const msgs = o.messages as Array<{ role?: string; content?: string }> | undefined;
      const user = Array.isArray(msgs) ? msgs.find((m) => m?.role === "user" && m.content) : undefined;
      if (user?.content) out.push(String(user.content));
    } catch {
      // Ligne non-JSON dans un .jsonl : on la prend telle quelle.
      out.push(t);
    }
  }
  return out;
}

/** CSV simple : première colonne textuelle, guillemets gérés. */
function fromCsv(raw: string): string[] {
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return [];
  const cell = (line: string) => {
    if (line.startsWith('"')) {
      const end = line.indexOf('"', 1);
      return end > 0 ? line.slice(1, end) : line.slice(1);
    }
    const comma = line.indexOf(",");
    return comma > 0 ? line.slice(0, comma) : line;
  };
  // On saute l'en-tête s'il ne ressemble pas à une donnée (pas d'espace).
  const body = /^[\w.\-,";]+$/.test(lines[0]!) && lines.length > 1 ? lines.slice(1) : lines;
  return body.map(cell).filter((s) => s.trim());
}

export function parseDocs(raw: string, dsType: string): string[] {
  const docs = dsType === "csv" ? fromCsv(raw) : dsType === "jsonl" || dsType === "json" ? fromJsonl(raw) : raw.split(/\n{2,}/);
  return docs.map((d) => d.trim()).filter((d) => d.length >= 8).slice(0, QUEUE_SIZE);
}

/** Documents réels du dataset qu'une tâche de labeling pointe. */
export function useDatasetQueue(dataset: FtDataset | undefined) {
  const [docs, setDocs] = useState<QueueDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const path = dataset?.storagePath ?? null;
  const dsType = dataset?.type ?? "jsonl";

  useEffect(() => {
    let cancelled = false;
    if (!path) {
      setDocs([]);
      setProblem(dataset ? "Ce dataset n'a pas de fichier importé — la file de validation lit les documents réels du fichier." : null);
      return;
    }
    setLoading(true);
    setProblem(null);
    void (async () => {
      try {
        const { data, error } = await supabase.storage.from("ft-datasets").createSignedUrl(path, 60);
        if (error || !data?.signedUrl) throw new Error(error?.message ?? "URL de téléchargement indisponible");
        const res = await fetch(data.signedUrl, { headers: { Range: `bytes=0-${MAX_BYTES - 1}` } });
        if (!res.ok && res.status !== 206) throw new Error(`Lecture du fichier impossible (${res.status})`);
        const raw = await res.text();
        if (cancelled) return;
        const parsed = parseDocs(raw, dsType);
        setDocs(parsed.map((text, i) => ({ id: `${path}#${i}`, text })));
        if (parsed.length === 0) setProblem("Aucun document exploitable n'a pu être lu dans ce fichier.");
      } catch (e) {
        if (!cancelled) { setDocs([]); setProblem(e instanceof Error ? e.message : "Lecture du dataset impossible"); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [path, dsType, dataset]);

  return { docs, loading, problem };
}

export interface Suggestion { set: string; value: string; confidence: number }

/** Labels proposés par le modèle pour UN document, restreints aux jeux donnés. */
export function useSuggestions(
  doc: QueueDoc | undefined,
  sets: LabelSet[],
  ctx: { workspaceId: string | null; projectId: string | null },
) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const key = doc?.id ?? "";
  const setKey = sets.map((s) => s.name).join(",");

  useEffect(() => {
    let cancelled = false;
    setSuggestions([]);
    setProblem(null);
    if (!doc || sets.length === 0 || !ctx.workspaceId || !ctx.projectId) return;
    setLoading(true);
    void (async () => {
      try {
        const res = await callEdge<{ suggestions?: Suggestion[] }>("aiops-infra", {
          action: "label.suggest",
          workspace_id: ctx.workspaceId,
          project_id: ctx.projectId,
          text: doc.text,
          label_sets: sets.map((s) => ({ name: s.name, values: s.values })),
        });
        if (!cancelled) setSuggestions(res.suggestions ?? []);
      } catch (e) {
        if (!cancelled) setProblem(e instanceof Error ? e.message : "Proposition indisponible");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setKey, ctx.workspaceId, ctx.projectId]);

  return { suggestions, loading, problem };
}
