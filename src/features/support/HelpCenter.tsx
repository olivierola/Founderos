import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Search, Sparkles, Loader2, ChevronLeft, BookOpen } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Public, unauthenticated help center. Data comes from the support-voice fn's
// portal_config / portal_ask public actions (service-role internally).

interface PortalConfig { title: string; brand_color: string | null; welcome: string | null; ai_enabled: boolean }
interface Article { id: string; title: string; body: string | null; category: string | null; helpful_yes: number; helpful_no: number }

async function portalCall(action: "portal_config" | "portal_ask", publicKey: string, body: Record<string, unknown> = {}) {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/support-voice?action=${action}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
    body: JSON.stringify({ public_key: publicKey, ...body }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Request failed");
  return res.json();
}

export function HelpCenterPage() {
  const { publicKey } = useParams();
  const [config, setConfig] = useState<PortalConfig | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Article | null>(null);
  const [aiAnswer, setAiAnswer] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    if (!publicKey) return;
    portalCall("portal_config", publicKey)
      .then((d) => { setConfig(d.portal); setArticles(d.articles ?? []); })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [publicKey]);

  const accent = config?.brand_color ?? "#e0457b";
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return articles;
    return articles.filter((a) => `${a.title} ${a.body ?? ""}`.toLowerCase().includes(s));
  }, [q, articles]);

  async function askAi() {
    if (!publicKey || !q.trim()) return;
    setAiBusy(true); setAiAnswer(null);
    try {
      const d = await portalCall("portal_ask", publicKey, { query: q.trim() });
      setAiAnswer(d.content ?? "No answer.");
    } catch (e) {
      setAiAnswer(e instanceof Error ? e.message : "Error");
    } finally { setAiBusy(false); }
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-zinc-50"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>;
  if (notFound || !config) return <div className="flex min-h-screen items-center justify-center bg-zinc-50 text-zinc-500">Help center not found.</div>;

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="px-6 py-12 text-center text-white" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}>
        <h1 className="text-3xl font-bold">{config.title}</h1>
        {config.welcome && <p className="mt-2 text-white/90">{config.welcome}</p>}
        <div className="mx-auto mt-6 flex max-w-xl items-center gap-2 rounded-xl bg-white p-1.5 shadow-lg">
          <Search className="ml-2 h-5 w-5 text-zinc-400" />
          <input
            value={q} onChange={(e) => { setQ(e.target.value); setAiAnswer(null); }}
            onKeyDown={(e) => e.key === "Enter" && config.ai_enabled && askAi()}
            placeholder="Search or ask a question…"
            className="flex-1 bg-transparent py-2 text-zinc-900 outline-none placeholder:text-zinc-400"
          />
          {config.ai_enabled && (
            <button onClick={askAi} disabled={aiBusy || !q.trim()} className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: accent }}>
              {aiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Ask AI
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8">
        {aiAnswer && (
          <div className="mb-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
            <div className="mb-2 flex items-center gap-1.5 text-sm font-medium" style={{ color: accent }}><Sparkles className="h-4 w-4" /> AI answer</div>
            <div className="prose prose-sm max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]}>{aiAnswer}</ReactMarkdown></div>
          </div>
        )}

        {open ? (
          <article className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <button onClick={() => setOpen(null)} className="mb-3 flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900"><ChevronLeft className="h-4 w-4" /> All articles</button>
            <h2 className="text-xl font-semibold">{open.title}</h2>
            <div className="prose prose-sm mt-3 max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]}>{open.body ?? ""}</ReactMarkdown></div>
          </article>
        ) : (
          <>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-500"><BookOpen className="h-4 w-4" /> {filtered.length} article{filtered.length === 1 ? "" : "s"}</h2>
            <div className="space-y-2">
              {filtered.map((a) => (
                <button key={a.id} onClick={() => setOpen(a)} className="block w-full rounded-xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition-shadow hover:shadow-md">
                  <div className="font-medium">{a.title}</div>
                  {a.body && <div className="mt-1 line-clamp-2 text-sm text-zinc-500">{a.body.replace(/[#*`]/g, "").slice(0, 160)}</div>}
                </button>
              ))}
              {filtered.length === 0 && <p className="py-8 text-center text-sm text-zinc-400">No articles match your search{config.ai_enabled ? " — try asking the AI." : "."}</p>}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
