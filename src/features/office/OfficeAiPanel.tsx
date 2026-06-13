import { useState } from "react";
import { Sparkles, Loader2, X, BookOpen, WandSparkles, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import type { OfficeKind } from "./shared";

// A slide-over assistant used inside every office editor. It calls office-ai
// with the current document context and returns either markdown (to insert) or
// structured content the editor knows how to apply.
export interface AiResult {
  action: "insert_markdown" | "replace_document" | "set_spreadsheet" | "set_slides" | "answer";
  markdown?: string;
  spreadsheet?: { columns: string[]; rows: (string | number | null)[][] };
  slides?: { title: string; body: string; layout?: string; notes?: string }[];
  answer?: string;
}

const QUICK_ACTIONS: Record<OfficeKind, { label: string; prompt: string; icon: any }[]> = {
  document: [
    { label: "Continue writing", prompt: "Continue le document à partir de là où il s'arrête.", icon: ArrowRight },
    { label: "Summarize", prompt: "Résume ce document en quelques points clés.", icon: WandSparkles },
    { label: "Improve", prompt: "Améliore la rédaction et la clarté du document.", icon: WandSparkles },
  ],
  spreadsheet: [
    { label: "Fill from prompt", prompt: "Remplis le tableur selon ma demande.", icon: WandSparkles },
    { label: "Add a summary row", prompt: "Ajoute une ligne de totaux/synthèse pertinente.", icon: ArrowRight },
  ],
  presentation: [
    { label: "Add slides", prompt: "Ajoute des slides pertinentes à cette présentation.", icon: ArrowRight },
    { label: "Speaker notes", prompt: "Rédige des notes d'orateur pour chaque slide.", icon: WandSparkles },
  ],
};

export function OfficeAiPanel({
  open, onClose, kind, docTitle, contextText, workspaceId, projectId, onResult,
}: {
  open: boolean;
  onClose: () => void;
  kind: OfficeKind;
  docTitle: string;
  contextText: string;
  workspaceId: string | null;
  projectId: string | null;
  onResult: (r: AiResult) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [useKnowledge, setUseKnowledge] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);

  async function run(p?: string) {
    const instruction = (p ?? prompt).trim();
    if (!instruction || !workspaceId || !projectId) return;
    setLoading(true); setError(null); setAnswer(null);
    try {
      const res = await callEdge<{ result: AiResult }>("office-ai", {
        workspace_id: workspaceId,
        project_id: projectId,
        kind,
        title: docTitle,
        context: contextText.slice(0, 8000),
        instruction,
        use_knowledge: useKnowledge,
      });
      if (res.result.action === "answer") {
        setAnswer(res.result.answer ?? "");
      } else {
        onResult(res.result);
        setPrompt("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" /> Assistant
        </span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-3 flex flex-wrap gap-1.5">
          {QUICK_ACTIONS[kind].map((qa) => (
            <button
              key={qa.label}
              onClick={() => run(qa.prompt)}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
            >
              <qa.icon className="h-3 w-3" /> {qa.label}
            </button>
          ))}
        </div>

        {answer && (
          <div className="mb-3 rounded-md border border-border bg-muted/20 p-3 text-sm whitespace-pre-wrap">
            {answer}
          </div>
        )}
        {error && <p className="mb-3 text-xs text-destructive">{error}</p>}
      </div>

      <div className="border-t border-border p-3">
        <button
          onClick={() => setUseKnowledge((v) => !v)}
          className={cn(
            "mb-2 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] transition-colors",
            useKnowledge ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          <BookOpen className="h-3 w-3" /> Knowledge base {useKnowledge ? "on" : "off"}
        </button>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }}
          rows={3}
          placeholder={`Ask the assistant to write, generate or edit this ${kind}…`}
          className="w-full resize-none rounded-md border border-input bg-background px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <Button className="mt-2 w-full" onClick={() => run()} disabled={loading || !prompt.trim()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Generate
        </Button>
      </div>
    </aside>
  );
}
