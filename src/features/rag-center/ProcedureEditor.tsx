import { useState } from "react";
import { ArrowLeft, Loader2, Trash2, FileText, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";

// Write a procedure straight into a collection, in markdown.
//
// A collection used to accept only uploaded files, which meant an internal
// rule — "escalate above 5 000 €", "never answer a refund request without the
// order id" — had to be turned into a PDF before an agent could know it. Here
// it is written where it is used, in the same editor as skills and workflow
// playbooks.
//
// It rides the existing text-source path: rag-ingest already chunks and embeds
// `type: "text"`. The one addition is keeping the ORIGINAL markdown in
// `metadata.body`, because chunks are for retrieval and cannot be edited back
// into a document.

export interface ProcedureSource {
  id: string;
  title: string;
  metadata?: { body?: string } | null;
}

export function ProcedureEditor({
  collectionId, workspaceId, projectId, source, onClose, onSaved,
}: {
  collectionId: string;
  workspaceId: string;
  projectId: string;
  /** Existing procedure to edit; omit to create one. */
  source?: ProcedureSource;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(source?.title ?? "");
  const [body, setBody] = useState(source?.metadata?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!title.trim() || !body.trim() || saving) return;
    setSaving(true); setError(null);
    try {
      // Re-ingesting replaces the chunks; the old source is dropped first so a
      // rewritten procedure cannot leave its previous wording retrievable.
      if (source) await supabase.from("rag_sources").delete().eq("id", source.id);
      await callEdge("rag-ingest", {
        workspace_id: workspaceId,
        project_id: projectId,
        collection_id: collectionId,
        type: "text",
        title: title.trim(),
        content: body,
      });
      // Keep the source markdown so the procedure stays editable — chunks are
      // for retrieval, not for reading back.
      const { data: fresh } = await supabase.from("rag_sources")
        .select("id").eq("collection_id", collectionId).eq("title", title.trim())
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (fresh) {
        await supabase.from("rag_sources")
          .update({ metadata: { body, authored: true } })
          .eq("id", (fresh as { id: string }).id);
      }
      setSavedAt(Date.now());
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enregistrement impossible");
    } finally { setSaving(false); }
  }

  async function remove() {
    if (!source || !confirm(`Supprimer la procédure « ${source.title} » ?`)) return;
    await supabase.from("rag_sources").delete().eq("id", source.id);
    onSaved();
    onClose();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <Button size="sm" variant="ghost" onClick={onClose}>
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Collection
        </Button>
        <FileText className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">{source ? "Modifier la procédure" : "Nouvelle procédure"}</span>
        {savedAt && Date.now() - savedAt < 3000 && (
          <span className="flex items-center gap-1 text-[11px] text-emerald-500"><Check className="h-3 w-3" /> Enregistrée</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {source && (
            <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={remove}>
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button size="sm" onClick={() => void save()} disabled={saving || !title.trim() || !body.trim()}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Enregistrer
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex h-full max-w-3xl flex-col px-8 py-6">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Politique de remboursement"
            className="mb-4 h-auto shrink-0 border-none bg-transparent px-0 text-2xl font-semibold tracking-tight shadow-none focus-visible:ring-0"
          />
          {error && <p className="mb-2 shrink-0 text-xs text-destructive">{error}</p>}
          <MarkdownEditor
            value={body}
            onChange={setBody}
            minHeight="60vh"
            className="flex-1"
            placeholder={"## Quand l'appliquer\n\nToute demande de remboursement passée sous 30 jours.\n\n## Règles\n\n1. Vérifier l'identifiant de commande avant toute réponse.\n2. Au-delà de 5 000 €, escalader au responsable.\n\n## Formulation attendue\n\n…"}
            footer={
              <span>
                Indexée dans la collection — les agents la retrouveront avec <code className="rounded bg-muted px-1">rag_search</code>,
                et un workflow peut la joindre à une étape précise.
              </span>
            }
          />
        </div>
      </div>
    </div>
  );
}
