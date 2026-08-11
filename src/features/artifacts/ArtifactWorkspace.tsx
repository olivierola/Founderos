/**
 * A hand-authored artifact: read it, or edit it in Editor.js.
 *
 * The agent path and the human path now differ only in WHERE the row lives
 * (internal_agent_deliverables carries a run_id the success contract verifies
 * against; office_documents belongs to a person). The FORMAT is identical, so
 * this screen and the agent viewer share the same renderer — a document written
 * by hand and one written by an agent are the same object to a reader.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, PencilLine, Eye, Trash2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/components/ToastProvider";
import { cn } from "@/lib/utils";
import { ArtifactEditor } from "./ArtifactEditor";
import { ArtifactReport, ArtifactDeck } from "./BlockRenderer";
import { parseDocument, type ArtifactDocument, type ArtifactTarget } from "./blocks";

interface Row { id: string; title: string; kind: ArtifactTarget; content: unknown }

export function ArtifactWorkspace({ docId, onBack, onDeleted }: {
  docId: string; onBack: () => void; onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["office_doc", docId],
    queryFn: async () => {
      const { data } = await supabase.from("office_documents")
        .select("id, title, kind, content").eq("id", docId).maybeSingle();
      return (data ?? null) as Row | null;
    },
  });
  useEffect(() => { if (data) setTitle(data.title); }, [data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const doc = parseDocument(data?.content);
  const isDeck = data?.kind === "presentation";

  // Debounced, and never on the first render: mounting is not a modification.
  const persist = (patch: Record<string, unknown>) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await supabase.from("office_documents").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", docId);
        qc.invalidateQueries({ queryKey: ["room_office_docs"] });
      } finally { setSaving(false); }
    }, 500);
  };

  async function remove() {
    if (!confirm(`Supprimer « ${title || "Sans titre"} » ? Définitif.`)) return;
    const { error } = await supabase.from("office_documents").delete().eq("id", docId);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["room_office_docs"] });
    toast.success("Artifact supprimé.");
    (onDeleted ?? onBack)();
  }

  if (isLoading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (!data) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Artifact introuvable.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="relative z-20 flex items-center gap-2 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
        <button type="button" onClick={onBack} title="Retour"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={title}
          onChange={(e) => { setTitle(e.target.value); persist({ title: e.target.value || "Sans titre" }); }}
          className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none"
          placeholder="Sans titre"
        />
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {isDeck ? "présentation" : "rapport"}
        </span>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <button
          type="button" onClick={() => setEditing((v) => !v)}
          className={cn("flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
            editing ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}
        >
          {editing ? <><Eye className="h-3.5 w-3.5" /> Aperçu</> : <><PencilLine className="h-3.5 w-3.5" /> Éditer</>}
        </button>
        <button type="button" onClick={remove} title="Supprimer"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
          <Trash2 className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {editing ? (
          <div className="mx-auto w-full max-w-[900px] px-8 py-8">
            <ArtifactEditor
              doc={doc}
              onChange={(next: ArtifactDocument) => persist({ content: next })}
            />
          </div>
        ) : isDeck ? <ArtifactDeck doc={doc} /> : <ArtifactReport doc={doc} />}
      </div>
    </div>
  );
}
