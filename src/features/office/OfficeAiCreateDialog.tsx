import { useEffect, useState } from "react";
import { Loader2, Sparkles, FileText, Table as TableIcon, Presentation } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import {
  type OfficeKind, KIND_META, markdownToSlate, extractPreview, emptyContent,
} from "./shared";

interface GenResult {
  title: string;
  markdown?: string;
  spreadsheet?: { columns: string[]; rows: (string | number | null)[][] };
  slides?: { title: string; body: string; layout?: string; notes?: string }[];
}

export function OfficeAiCreateDialog({
  open, onOpenChange, workspaceId, projectId, onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string | null;
  projectId: string | null;
  onCreated: (id: string, kind: OfficeKind) => void;
}) {
  const { user } = useAuth();
  const [kind, setKind] = useState<OfficeKind>("document");
  const [prompt, setPrompt] = useState("");
  const [useKnowledge, setUseKnowledge] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setPrompt(""); setError(null); setKind("document"); } }, [open]);

  async function generate() {
    if (!workspaceId || !projectId || !user || !prompt.trim()) return;
    setLoading(true); setError(null);
    try {
      const res = await callEdge<{ result: GenResult }>("office-ai", {
        workspace_id: workspaceId,
        project_id: projectId,
        kind,
        mode: "create",
        instruction: prompt.trim(),
        use_knowledge: useKnowledge,
      });
      const g = res.result;

      // Build the content payload for the chosen kind.
      let content: any = emptyContent(kind);
      if (kind === "document" && g.markdown != null) content = { nodes: markdownToSlate(g.markdown) };
      else if (kind === "spreadsheet" && g.spreadsheet) content = g.spreadsheet;
      else if (kind === "presentation" && g.slides) {
        content = {
          slides: g.slides.map((s) => ({
            title: s.title ?? "Slide",
            body: s.body ?? "",
            layout: (["title", "title-content", "section", "blank"].includes(s.layout ?? "") ? s.layout : "title-content"),
            notes: s.notes,
          })),
        };
      }

      const { data, error: insErr } = await supabase
        .from("office_documents")
        .insert({
          workspace_id: workspaceId,
          project_id: projectId,
          kind,
          title: g.title?.slice(0, 120) || `Untitled ${KIND_META[kind].label.toLowerCase()}`,
          content,
          preview_text: extractPreview(kind, content),
          emoji: KIND_META[kind].emoji,
          created_by: user.id,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      onOpenChange(false);
      onCreated(data!.id, kind);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const KIND_ICON = { document: FileText, spreadsheet: TableIcon, presentation: Presentation };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> Create with AI</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Type</label>
            <div className="grid grid-cols-3 gap-2">
              {(["document", "spreadsheet", "presentation"] as OfficeKind[]).map((k) => {
                const Icon = KIND_ICON[k];
                return (
                  <button
                    key={k}
                    onClick={() => setKind(k)}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors",
                      kind === k ? "border-primary bg-primary/5 font-medium" : "border-border text-muted-foreground hover:bg-secondary",
                    )}
                  >
                    <Icon className={cn("h-5 w-5", KIND_META[k].accent)} />
                    {KIND_META[k].label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">What do you want to create?</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              autoFocus
              placeholder={
                kind === "document" ? "Ex. Un one-pager sur notre produit pour les investisseurs…"
                : kind === "spreadsheet" ? "Ex. Un budget marketing trimestriel avec catégories et montants…"
                : "Ex. Une présentation de 6 slides pour pitcher notre SaaS…"
              }
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <button
            onClick={() => setUseKnowledge((v) => !v)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition-colors",
              useKnowledge ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
            )}
          >
            Use knowledge base {useKnowledge ? "on" : "off"}
          </button>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={generate} disabled={loading || !prompt.trim()}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Generate
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
