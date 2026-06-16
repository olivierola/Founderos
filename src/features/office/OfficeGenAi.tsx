import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Image as ImageIcon, Clapperboard, PenLine, Loader2, Sparkles, Copy, Check, Wand2,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useProjectConnectors } from "@/hooks/useConnectors";
import { cn } from "@/lib/utils";

// ── Copywriter — reuses the office-ai edge to draft copy as markdown ─────────
export function OfficeCopywriterPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const [prompt, setPrompt] = useState("");
  const [tone, setTone] = useState("Professional");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string>("");
  const [copied, setCopied] = useState(false);

  async function generate() {
    if (!workspaceId || !projectId || !prompt.trim() || loading) return;
    setLoading(true);
    setResult("");
    try {
      const res = await callEdge<{ result: { markdown?: string; answer?: string } }>("office-ai", {
        workspace_id: workspaceId, project_id: projectId, kind: "document", mode: "create",
        instruction: `Write marketing copy. Tone: ${tone}. Brief: ${prompt.trim()}`,
      });
      setResult(res.result?.markdown || res.result?.answer || "(no output)");
    } catch (e: any) {
      setResult(`Error: ${e?.message ?? "generation failed"}`);
    } finally {
      setLoading(false);
    }
  }
  function copy() {
    navigator.clipboard.writeText(result);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Copywriter" description="Generate on-brand marketing copy — landing pages, emails, posts, ads." />
      <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
        <div className="space-y-3">
          <Field label="What do you want to write?">
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6}
              placeholder="e.g. A launch email for our new AI cockpit, highlighting one-panel management and time saved."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </Field>
          <Field label="Tone">
            <div className="flex flex-wrap gap-1.5">
              {["Professional", "Playful", "Bold", "Minimal", "Technical", "Friendly"].map((t) => (
                <button key={t} onClick={() => setTone(t)}
                  className={cn("rounded-full border px-2.5 py-1 text-xs transition-colors", tone === t ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>{t}</button>
              ))}
            </div>
          </Field>
          <Button onClick={generate} disabled={loading || !prompt.trim()} className="w-full">
            {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />} Generate copy
          </Button>
        </div>

        <div className="min-h-[300px] rounded-xl border border-border bg-card p-4">
          {result ? (
            <>
              <div className="mb-2 flex justify-end">
                <button onClick={copy} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-secondary">
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{result}</ReactMarkdown>
              </div>
            </>
          ) : (
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              <PenLine className="h-7 w-7 opacity-50" /> Your generated copy appears here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Media studio shell (Image / Video) — prompt UI + provider-aware ──────────
function MediaStudio({ kind }: { kind: "image" | "video" }) {
  const { projectId } = useCurrentContext();
  const { data: connectors } = useProjectConnectors(projectId ?? null);
  const providers = kind === "image" ? ["cloudinary", "canva", "unsplash"] : ["cloudinary"];
  const connected = (connectors ?? []).some((c) => providers.includes(c.provider) && c.status === "connected");

  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("16:9");
  const Icon = kind === "image" ? ImageIcon : Clapperboard;

  return (
    <div className="space-y-5">
      <PageHeader
        title={kind === "image" ? "Image studio" : "Video studio"}
        description={kind === "image" ? "Generate on-brand visuals from a prompt." : "Generate short videos and motion clips from a prompt."}
      />
      <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
        <div className="space-y-3">
          <Field label="Prompt">
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6}
              placeholder={kind === "image" ? "A clean product hero shot, soft studio light, brand colors…" : "A 6s loop of a dashboard coming to life, smooth camera move…"}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </Field>
          <Field label="Aspect ratio">
            <div className="flex flex-wrap gap-1.5">
              {["1:1", "16:9", "9:16", "4:3"].map((r) => (
                <button key={r} onClick={() => setRatio(r)}
                  className={cn("rounded-full border px-2.5 py-1 text-xs transition-colors", ratio === r ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>{r}</button>
              ))}
            </div>
          </Field>
          <Button disabled={!connected || !prompt.trim()} className="w-full">
            <Wand2 className="mr-1.5 h-4 w-4" /> Generate
          </Button>
          {!connected && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-muted-foreground">
              Connect a media provider ({providers.join(", ")}) in <span className="font-medium text-foreground">Integrations</span> to enable generation.
            </p>
          )}
        </div>

        <div className="grid min-h-[300px] grid-cols-2 gap-3 rounded-xl border border-dashed border-border p-4 sm:grid-cols-3">
          <div className="col-span-full flex h-full min-h-[260px] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <Icon className="h-7 w-7 opacity-50" /> Generated {kind === "image" ? "images" : "clips"} will appear here.
          </div>
        </div>
      </div>
    </div>
  );
}

export function OfficeImageStudioPage() { return <MediaStudio kind="image" />; }
export function OfficeVideoStudioPage() { return <MediaStudio kind="video" />; }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><label className="text-xs font-medium text-muted-foreground">{label}</label>{children}</div>;
}
