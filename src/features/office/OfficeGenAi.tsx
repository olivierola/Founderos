import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Image as ImageIcon, Clapperboard, PenLine, Loader2, Sparkles, Copy, Check, Wand2,
  Trash2, ExternalLink, AlertCircle,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { callEdge } from "@/lib/edge";
import { supabase } from "@/lib/supabase";
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

// ── Media studios (Image / Video) — real generation via office-ai media.* ────
// Providers: fal.ai (FLUX images, Kling video) or OpenAI (gpt-image-1, Sora),
// resolved from the workspace's connected credentials. Results are stored in
// the `office-media` bucket and listed from the office_media table (RLS).

interface OfficeMedia {
  id: string; kind: "image" | "video"; prompt: string; ratio: string | null;
  provider: string; model: string | null; status: "generating" | "ready" | "failed";
  url: string | null; error_message: string | null; created_at: string;
}

const GEN_PROVIDERS = ["fal", "openai"] as const;
const PROVIDER_LABEL: Record<string, string> = { fal: "fal.ai", openai: "OpenAI" };

function MediaStudio({ kind }: { kind: "image" | "video" }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { data: connectors } = useProjectConnectors(projectId ?? null);
  const queryClient = useQueryClient();
  const available = GEN_PROVIDERS.filter((p) =>
    (connectors ?? []).some((c) => c.provider === p && c.status === "connected"));
  const connected = available.length > 0;

  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("16:9");
  const [provider, setProvider] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const activeProvider = provider && available.includes(provider as typeof GEN_PROVIDERS[number]) ? provider : available[0];
  const Icon = kind === "image" ? ImageIcon : Clapperboard;

  const { data: items } = useQuery({
    queryKey: ["office_media", projectId, kind],
    enabled: !!projectId,
    queryFn: async () => {
      const { data, error } = await supabase.from("office_media")
        .select("id, kind, prompt, ratio, provider, model, status, url, error_message, created_at")
        .eq("project_id", projectId!).eq("kind", kind)
        .order("created_at", { ascending: false }).limit(60);
      if (error) throw new Error(error.message);
      return (data ?? []) as OfficeMedia[];
    },
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["office_media", projectId, kind] });

  // Poll office-ai media.sync while generations are in flight (fal queue / Sora).
  const pendingIds = (items ?? []).filter((i) => i.status === "generating").map((i) => i.id);
  useEffect(() => {
    if (pendingIds.length === 0 || !workspaceId || !projectId) return;
    const t = setInterval(async () => {
      await Promise.all(pendingIds.map((id) =>
        callEdge("office-ai", { op: "media.sync", workspace_id: workspaceId, project_id: projectId, media_id: id }).catch(() => null)));
      invalidate();
    }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingIds.join(","), workspaceId, projectId]);

  async function generate() {
    if (!workspaceId || !projectId || !prompt.trim() || busy || !connected) return;
    setBusy(true); setGenError(null);
    try {
      await callEdge<{ media: OfficeMedia }>("office-ai", {
        op: "media.generate", workspace_id: workspaceId, project_id: projectId,
        kind, prompt: prompt.trim(), ratio, provider: activeProvider,
      });
      invalidate();
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "La génération a échoué");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!workspaceId || !projectId) return;
    await callEdge("office-ai", { op: "media.delete", workspace_id: workspaceId, project_id: projectId, media_id: id }).catch(() => null);
    invalidate();
  }

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
          {available.length > 1 && (
            <Field label="Provider">
              <div className="flex flex-wrap gap-1.5">
                {available.map((p) => (
                  <button key={p} onClick={() => setProvider(p)}
                    className={cn("rounded-full border px-2.5 py-1 text-xs transition-colors", activeProvider === p ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>
                    {PROVIDER_LABEL[p]}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <Button onClick={generate} disabled={!connected || !prompt.trim() || busy} className="w-full">
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1.5 h-4 w-4" />} Generate
          </Button>
          {genError && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">{genError}</p>
          )}
          {!connected && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-muted-foreground">
              Connect <span className="font-medium text-foreground">fal.ai</span> or <span className="font-medium text-foreground">OpenAI</span> in
              <span className="font-medium text-foreground"> Integrations → Credentials Vault</span> to enable generation.
            </p>
          )}
        </div>

        {(items ?? []).length === 0 ? (
          <div className="grid min-h-[300px] rounded-xl border border-dashed border-border p-4">
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              <Icon className="h-7 w-7 opacity-50" /> Generated {kind === "image" ? "images" : "clips"} will appear here.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 content-start gap-3 sm:grid-cols-3">
            {(items ?? []).map((m) => <MediaCard key={m.id} media={m} onDelete={() => remove(m.id)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function MediaCard({ media, onDelete }: { media: OfficeMedia; onDelete: () => void }) {
  const [copied, setCopied] = useState(false);
  const copyUrl = () => {
    if (!media.url) return;
    navigator.clipboard.writeText(media.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex aspect-square items-center justify-center bg-muted/40">
        {media.status === "generating" ? (
          <div className="flex flex-col items-center gap-2 p-3 text-center text-xs text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> Generating…
          </div>
        ) : media.status === "failed" ? (
          <div className="flex flex-col items-center gap-2 p-3 text-center text-xs text-destructive">
            <AlertCircle className="h-5 w-5" />
            <span className="line-clamp-4">{media.error_message ?? "Generation failed"}</span>
          </div>
        ) : media.kind === "image" ? (
          <img src={media.url ?? ""} alt={media.prompt} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <video src={media.url ?? ""} controls playsInline className="h-full w-full object-cover" />
        )}
      </div>
      <div className="space-y-1 p-2">
        <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground" title={media.prompt}>{media.prompt}</p>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
          <span>{PROVIDER_LABEL[media.provider] ?? media.provider}</span>
          {media.model && <span>· {media.model.split("/").pop()}</span>}
          {media.ratio && <span>· {media.ratio}</span>}
        </div>
      </div>
      <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {media.url && (
          <>
            <button onClick={copyUrl} title="Copy URL" className="rounded-md bg-background/85 p-1.5 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground">
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            <a href={media.url} target="_blank" rel="noreferrer" title="Open" className="rounded-md bg-background/85 p-1.5 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </>
        )}
        <button onClick={onDelete} title="Delete" className="rounded-md bg-background/85 p-1.5 text-muted-foreground shadow-sm backdrop-blur hover:text-destructive">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function OfficeImageStudioPage() { return <MediaStudio kind="image" />; }
export function OfficeVideoStudioPage() { return <MediaStudio kind="video" />; }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><label className="text-xs font-medium text-muted-foreground">{label}</label>{children}</div>;
}
