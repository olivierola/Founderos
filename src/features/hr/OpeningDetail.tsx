import { useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, ArrowLeft, Briefcase, Users, GitBranch, Settings2, Plus, Trash2,
  Save, Check, Sparkles, Star, Calendar, GripVertical, X, ChevronUp, ChevronDown,
  Download, AlertTriangle,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import {
  type Opening, type Stage, type Candidate, type Criterion, type Evaluation, type Interview,
  type SourcedCandidate, OPENING_STATUS, STAGE_KIND_ACCENT, INTERVIEW_KIND, SOURCE_PROVIDERS,
  screenCandidate, weightedScore, fetchSourcedCandidates,
} from "./recruitmentTypes";

const TABS = [
  { key: "overview", label: "Fiche", icon: Briefcase },
  { key: "candidates", label: "Candidatures", icon: Users },
  { key: "pipeline", label: "Avancement", icon: GitBranch },
  { key: "ats", label: "Paramétrage ATS", icon: Settings2 },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function OpeningDetailPage() {
  const { openingId, tab: tabParam } = useParams();
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const tab: TabKey = (TABS.some((t) => t.key === tabParam) ? tabParam : "overview") as TabKey;

  const { data: opening, isLoading } = useQuery({
    queryKey: ["hr_opening", openingId],
    enabled: !!openingId,
    queryFn: async () => {
      const { data } = await supabase.from("hr_job_openings").select("*").eq("id", openingId!).maybeSingle();
      return data as Opening | null;
    },
  });

  if (isLoading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!opening) return <EmptyState icon={Briefcase} title="Opening not found" />;

  const base = `/app/${workspaceSlug}/${projectSlug}/hr/opening/${openingId}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/hr/recruitment`)}><ArrowLeft className="mr-1 h-3.5 w-3.5" /> Recruitment</Button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{opening.title}</h1>
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", OPENING_STATUS[opening.status].cls)}>{OPENING_STATUS[opening.status].label}</span>
      </div>

      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.key} onClick={() => navigate(`${base}/${t.key}`)}
              className={cn("flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
                tab === t.key ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              <Icon className="h-4 w-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === "overview" && <OverviewTab opening={opening} />}
      {tab === "candidates" && <CandidatesTab opening={opening} />}
      {tab === "pipeline" && <PipelineTab opening={opening} />}
      {tab === "ats" && <AtsTab opening={opening} />}
    </div>
  );
}

// ------------------------------------------------------------ Fiche (overview)
function OverviewTab({ opening }: { opening: Opening }) {
  const queryClient = useQueryClient();
  const [d, setD] = useState<Opening>(opening);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  function set<K extends keyof Opening>(k: K, v: Opening[K]) { setD((p) => ({ ...p, [k]: v })); }

  async function save() {
    setSaving(true);
    try {
      await supabase.from("hr_job_openings").update({
        title: d.title, department: d.department, location: d.location, employment_type: d.employment_type,
        salary_range: d.salary_range, description: d.description, requirements: d.requirements,
        status: d.status, target_close: d.target_close || null,
      }).eq("id", opening.id);
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["hr_opening", opening.id] });
      queryClient.invalidateQueries({ queryKey: ["hr_openings"] });
    } finally { setSaving(false); }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Job description</CardTitle>
          <div className="flex items-center gap-2">
            {savedAt && Date.now() - savedAt < 3000 && <span className="text-xs text-muted-foreground"><Check className="mr-1 inline h-3 w-3" /> Saved</span>}
            <Button size="sm" onClick={save} disabled={saving}>{saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}<span className="ml-1">Save</span></Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4">
        <L label="Title" full><Input value={d.title} onChange={(e) => set("title", e.target.value)} /></L>
        <L label="Department"><Input value={d.department ?? ""} onChange={(e) => set("department", e.target.value)} /></L>
        <L label="Location"><Input value={d.location ?? ""} onChange={(e) => set("location", e.target.value)} /></L>
        <L label="Employment type">
          <select value={d.employment_type} onChange={(e) => set("employment_type", e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
            {["full_time", "part_time", "contractor", "intern"].map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
          </select>
        </L>
        <L label="Salary range"><Input value={d.salary_range ?? ""} onChange={(e) => set("salary_range", e.target.value)} /></L>
        <L label="Status">
          <select value={d.status} onChange={(e) => set("status", e.target.value as Opening["status"])} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
            {Object.keys(OPENING_STATUS).map((s) => <option key={s} value={s}>{OPENING_STATUS[s as Opening["status"]].label}</option>)}
          </select>
        </L>
        <L label="Target close"><Input type="date" value={d.target_close ?? ""} onChange={(e) => set("target_close", e.target.value)} /></L>
        <L label="Description" full><textarea value={d.description ?? ""} onChange={(e) => set("description", e.target.value)} rows={5} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" /></L>
        <L label="Requirements" full><textarea value={d.requirements ?? ""} onChange={(e) => set("requirements", e.target.value)} rows={4} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" placeholder="Must-have skills, experience…" /></L>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------- shared data hooks
function useStages(openingId: string) {
  return useQuery({
    queryKey: ["hr_stages", openingId],
    queryFn: async () => {
      const { data } = await supabase.from("hr_pipeline_stages").select("*").eq("opening_id", openingId).order("position");
      return (data ?? []) as Stage[];
    },
  });
}
function useCandidates(openingId: string) {
  return useQuery({
    queryKey: ["hr_opening_candidates", openingId],
    queryFn: async () => {
      const { data } = await supabase.from("hr_candidates").select("*").eq("opening_id", openingId).order("created_at", { ascending: false });
      return (data ?? []) as Candidate[];
    },
  });
}

// ----------------------------------------------------------- Candidatures tab
function CandidatesTab({ opening }: { opening: Opening }) {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const { data: candidates, isLoading } = useCandidates(opening.id);
  const { data: stages } = useStages(opening.id);
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const stageName = (id: string | null) => (stages ?? []).find((s) => s.id === id)?.name ?? "—";

  async function add(draft: Partial<Candidate>) {
    if (!workspaceId || !projectId) return;
    const firstStage = (stages ?? [])[0]?.id ?? null;
    await supabase.from("hr_candidates").insert({ ...draft, opening_id: opening.id, stage_id: firstStage, workspace_id: workspaceId, project_id: projectId });
    queryClient.invalidateQueries({ queryKey: ["hr_opening_candidates", opening.id] });
    setOpen(false);
  }

  async function importMany(rows: SourcedCandidate[], source: string) {
    if (!workspaceId || !projectId || rows.length === 0) return;
    const firstStage = (stages ?? [])[0]?.id ?? null;
    const existing = new Set((candidates ?? []).map((c) => (c.email ?? "").toLowerCase()).filter(Boolean));
    const toInsert = rows
      .filter((r) => !r.email || !existing.has(r.email.toLowerCase()))
      .map((r) => ({
        opening_id: opening.id, stage_id: firstStage, workspace_id: workspaceId, project_id: projectId,
        full_name: r.full_name, email: r.email, phone: r.phone, location: r.location,
        resume_text: r.resume_text, source, source_ref: r.external_ref, applied_at: new Date().toISOString(),
      }));
    if (toInsert.length) await supabase.from("hr_candidates").insert(toInsert);
    queryClient.invalidateQueries({ queryKey: ["hr_opening_candidates", opening.id] });
    setImportOpen(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}><Download className="h-4 w-4" /> Import from source</Button>
        <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add candidate</Button>
      </div>
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (candidates ?? []).length === 0 ? <EmptyState icon={Users} title="No candidates" description="Add candidates to this opening." />
        : (
          <Card><CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                <tr><th className="px-3 py-2">Candidate</th><th className="px-3 py-2">Stage</th><th className="px-3 py-2">Source</th><th className="px-3 py-2 text-center">AI fit</th><th className="px-3 py-2 text-center">Rating</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(candidates ?? []).map((c) => (
                  <tr key={c.id} className="cursor-pointer hover:bg-muted/30" onClick={() => setSelected(c)}>
                    <td className="px-3 py-2"><div className="font-medium">{c.full_name}</div>{c.email && <div className="text-[11px] text-muted-foreground">{c.email}</div>}</td>
                    <td className="px-3 py-2 text-muted-foreground">{stageName(c.stage_id)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{c.source || "—"}</td>
                    <td className="px-3 py-2 text-center">{c.ai_score != null ? <FitBadge score={c.ai_score} /> : <span className="text-xs text-muted-foreground">—</span>}</td>
                    <td className="px-3 py-2 text-center">{c.rating ? `${c.rating}★` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent></Card>
        )}

      <AddCandidateDialog open={open} onOpenChange={setOpen} onCreate={add} />
      <ImportSourceDialog open={importOpen} onOpenChange={setImportOpen} onImport={importMany} />
      {selected && <CandidateDrawer candidate={selected} opening={opening} stages={stages ?? []} onClose={() => setSelected(null)} />}
    </div>
  );
}

// Pull candidatures from a connected ATS source (Greenhouse/Lever/Workable/LinkedIn).
function ImportSourceDialog({ open, onOpenChange, onImport }: { open: boolean; onOpenChange: (o: boolean) => void; onImport: (rows: SourcedCandidate[], source: string) => Promise<void> }) {
  const { workspaceId, projectId } = useCurrentContext();
  const [provider, setProvider] = useState(SOURCE_PROVIDERS[0].slug);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<SourcedCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const def = SOURCE_PROVIDERS.find((p) => p.slug === provider)!;

  async function fetchNow() {
    if (!workspaceId || !projectId) return;
    setLoading(true); setError(null); setRows(null);
    try {
      const r = await fetchSourcedCandidates(workspaceId, projectId, def.slug, def.action);
      setRows(r);
      setPicked(new Set(r.map((x) => x.external_ref)));
      if (r.length === 0) setError("No candidates returned by this source.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch — is the integration connected?");
    } finally { setLoading(false); }
  }
  function toggle(ref: string) { setPicked((p) => { const n = new Set(p); n.has(ref) ? n.delete(ref) : n.add(ref); return n; }); }
  async function run() {
    if (!rows) return;
    setImporting(true);
    try { await onImport(rows.filter((r) => picked.has(r.external_ref)), def.label); setRows(null); setPicked(new Set()); }
    finally { setImporting(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Download className="h-4 w-4" /> Import candidatures</DialogTitle></DialogHeader>
        <div className="flex items-end gap-2">
          <L label="Source">
            <select value={provider} onChange={(e) => { setProvider(e.target.value); setRows(null); setError(null); }} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {SOURCE_PROVIDERS.map((p) => <option key={p.slug} value={p.slug}>{p.label}</option>)}
            </select>
          </L>
          <Button onClick={fetchNow} disabled={loading}>{loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1 h-3.5 w-3.5" />}Fetch</Button>
        </div>
        <p className="text-[11px] text-muted-foreground">Connect the source first in the integrations catalog. Candidates already on this opening (matched by email) are skipped.</p>

        {error && <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600"><AlertTriangle className="h-3.5 w-3.5" /> {error}</div>}

        {rows && rows.length > 0 && (
          <>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{picked.size} of {rows.length} selected</span>
              <button className="hover:text-foreground" onClick={() => setPicked(picked.size === rows.length ? new Set() : new Set(rows.map((r) => r.external_ref)))}>{picked.size === rows.length ? "Deselect all" : "Select all"}</button>
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border p-1">
              {rows.map((r) => (
                <label key={r.external_ref} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/40">
                  <input type="checkbox" checked={picked.has(r.external_ref)} onChange={() => toggle(r.external_ref)} className="accent-primary" />
                  <span className="font-medium">{r.full_name}</span>
                  {r.email && <span className="text-[11px] text-muted-foreground">{r.email}</span>}
                  {r.location && <span className="ml-auto text-[11px] text-muted-foreground">{r.location}</span>}
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={run} disabled={importing || picked.size === 0}>{importing && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Import {picked.size}</Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FitBadge({ score }: { score: number }) {
  const cls = score >= 75 ? "bg-emerald-500/15 text-emerald-600" : score >= 50 ? "bg-amber-500/15 text-amber-600" : "bg-destructive/15 text-destructive";
  return <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", cls)}>{score}</span>;
}

function AddCandidateDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: Partial<Candidate>) => Promise<void> }) {
  const [d, setD] = useState<Partial<Candidate>>({});
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.full_name?.trim()) return; setSaving(true); try { await onCreate(d); setD({}); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Add candidate</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <L label="Full name" full><Input value={d.full_name ?? ""} onChange={(e) => setD((p) => ({ ...p, full_name: e.target.value }))} autoFocus /></L>
          <L label="Email"><Input type="email" value={d.email ?? ""} onChange={(e) => setD((p) => ({ ...p, email: e.target.value }))} /></L>
          <L label="Phone"><Input value={d.phone ?? ""} onChange={(e) => setD((p) => ({ ...p, phone: e.target.value }))} /></L>
          <L label="Source"><Input value={d.source ?? ""} onChange={(e) => setD((p) => ({ ...p, source: e.target.value }))} placeholder="LinkedIn…" /></L>
          <L label="Location"><Input value={d.location ?? ""} onChange={(e) => setD((p) => ({ ...p, location: e.target.value }))} /></L>
          <L label="Resume / CV text (for AI screening)" full><textarea value={d.resume_text ?? ""} onChange={(e) => setD((p) => ({ ...p, resume_text: e.target.value }))} rows={5} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" placeholder="Paste the candidate's CV / experience here…" /></L>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Add</Button></div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------- candidate drawer (eval + AI + interviews)
function CandidateDrawer({ candidate, opening, stages, onClose }: { candidate: Candidate; opening: Opening; stages: Stage[]; onClose: () => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [screening, setScreening] = useState(false);

  const { data: criteria } = useQuery({
    queryKey: ["hr_criteria", opening.id],
    queryFn: async () => {
      const { data } = await supabase.from("hr_scorecard_criteria").select("*").eq("opening_id", opening.id).order("position");
      return (data ?? []) as Criterion[];
    },
  });
  const { data: evals } = useQuery({
    queryKey: ["hr_evals", candidate.id],
    queryFn: async () => {
      const { data } = await supabase.from("hr_evaluations").select("*").eq("candidate_id", candidate.id);
      return (data ?? []) as Evaluation[];
    },
  });
  const { data: interviews } = useQuery({
    queryKey: ["hr_interviews", candidate.id],
    queryFn: async () => {
      const { data } = await supabase.from("hr_interviews").select("*").eq("candidate_id", candidate.id).order("scheduled_at");
      return (data ?? []) as Interview[];
    },
  });

  const evalByCrit = useMemo(() => { const m: Record<string, Evaluation> = {}; (evals ?? []).forEach((e) => (m[e.criterion_id] = e)); return m; }, [evals]);
  const score = weightedScore(evals ?? [], criteria ?? []);

  async function setStage(stageId: string) {
    await supabase.from("hr_candidates").update({ stage_id: stageId }).eq("id", candidate.id);
    queryClient.invalidateQueries({ queryKey: ["hr_opening_candidates", opening.id] });
  }
  async function setEval(criterionId: string, partial: Partial<Evaluation>) {
    const existing = evalByCrit[criterionId];
    if (existing) await supabase.from("hr_evaluations").update(partial).eq("id", existing.id);
    else await supabase.from("hr_evaluations").insert({ candidate_id: candidate.id, criterion_id: criterionId, workspace_id: workspaceId, project_id: projectId, evaluator_id: user?.id ?? null, ...partial });
    queryClient.invalidateQueries({ queryKey: ["hr_evals", candidate.id] });
  }
  async function screen() {
    if (!workspaceId || !projectId) return;
    setScreening(true);
    try { await screenCandidate(workspaceId, projectId, candidate.id); queryClient.invalidateQueries({ queryKey: ["hr_opening_candidates", opening.id] }); }
    catch (e) { alert(e instanceof Error ? e.message : "Screening failed"); }
    finally { setScreening(false); }
  }

  // Live candidate (to reflect AI screening updates without reopening).
  const { data: live } = useQuery({
    queryKey: ["hr_candidate", candidate.id],
    queryFn: async () => { const { data } = await supabase.from("hr_candidates").select("*").eq("id", candidate.id).maybeSingle(); return data as Candidate | null; },
    initialData: candidate,
  });
  const c = live ?? candidate;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside className="flex h-full w-full max-w-md flex-col border-l border-border bg-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0"><div className="truncate font-semibold">{c.full_name}</div><div className="truncate text-xs text-muted-foreground">{c.email || "—"}</div></div>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {/* Stage */}
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">Pipeline stage</div>
            <select value={c.stage_id ?? ""} onChange={(e) => setStage(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          {/* AI screening */}
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-sm font-medium text-primary"><Sparkles className="h-4 w-4" /> AI screening</span>
                <Button size="sm" variant="outline" onClick={screen} disabled={screening}>{screening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {c.ai_screened_at ? "Re-run" : "Screen"}</Button>
              </div>
              {c.ai_score != null ? (
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">Fit</span><FitBadge score={c.ai_score} /></div>
                  {c.ai_summary && <div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{c.ai_summary}</ReactMarkdown></div>}
                  {c.ai_strengths && <div><div className="text-[11px] font-medium text-emerald-600">Strengths</div><div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{c.ai_strengths}</ReactMarkdown></div></div>}
                  {c.ai_gaps && <div><div className="text-[11px] font-medium text-amber-600">Gaps</div><div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{c.ai_gaps}</ReactMarkdown></div></div>}
                </div>
              ) : <p className="text-xs text-muted-foreground">{c.resume_text ? "Run AI to score this candidate against the job." : "Add resume text to enable AI screening."}</p>}
            </CardContent>
          </Card>

          {/* Scorecard */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">Scorecard {score != null && <span className="text-muted-foreground">· {score}/100</span>}</span>
            </div>
            {(criteria ?? []).length === 0 ? <p className="text-xs text-muted-foreground">No criteria yet — add them in the ATS settings tab.</p>
              : (criteria ?? []).map((cr) => {
                const ev = evalByCrit[cr.id];
                return (
                  <div key={cr.id} className="mb-2 rounded-md border border-border p-2">
                    <div className="flex items-center justify-between"><span className="text-sm">{cr.label}</span><span className="text-[10px] text-muted-foreground">×{cr.weight}</span></div>
                    <div className="mt-1 flex gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button key={n} onClick={() => setEval(cr.id, { score: n })}>
                          <Star className={cn("h-4 w-4", (ev?.score ?? 0) >= n ? "fill-amber-400 text-amber-400" : "text-muted-foreground")} />
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
          </div>

          {/* Interviews */}
          <InterviewSection candidate={c} opening={opening} interviews={interviews ?? []} />
        </div>
      </aside>
    </div>
  );
}

function InterviewSection({ candidate, opening, interviews }: { candidate: Candidate; opening: Opening; interviews: Interview[] }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  async function add(d: Partial<Interview>) {
    if (!workspaceId || !projectId) return;
    await supabase.from("hr_interviews").insert({ ...d, candidate_id: candidate.id, opening_id: opening.id, workspace_id: workspaceId, project_id: projectId, created_by: user?.id ?? null });
    queryClient.invalidateQueries({ queryKey: ["hr_interviews", candidate.id] });
    setOpen(false);
  }
  async function setStatus(id: string, status: Interview["status"]) {
    await supabase.from("hr_interviews").update({ status }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["hr_interviews", candidate.id] });
  }
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">Interviews</span>
        <Button size="sm" variant="ghost" className="h-7" onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5" /> Schedule</Button>
      </div>
      {interviews.length === 0 ? <p className="text-xs text-muted-foreground">No interviews scheduled.</p>
        : interviews.map((iv) => (
          <div key={iv.id} className="mb-2 rounded-md border border-border p-2 text-sm">
            <div className="flex items-center gap-2">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium">{iv.title}</span>
              <Badge variant="outline" className="text-[10px] capitalize">{iv.kind}</Badge>
              <select value={iv.status} onChange={(e) => setStatus(iv.id, e.target.value as Interview["status"])} className="ml-auto rounded border border-input bg-background px-1 py-0.5 text-[10px] capitalize">
                {["scheduled", "done", "cancelled", "no_show"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
              </select>
            </div>
            {iv.scheduled_at && <div className="mt-0.5 text-[11px] text-muted-foreground">{new Date(iv.scheduled_at).toLocaleString()} · {iv.duration_min}min</div>}
          </div>
        ))}
      <InterviewDialog open={open} onOpenChange={setOpen} onCreate={add} />
    </div>
  );
}

function InterviewDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: Partial<Interview>) => Promise<void> }) {
  const [d, setD] = useState<Partial<Interview>>({ kind: "phone", duration_min: 45, status: "scheduled" });
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.title?.trim()) return; setSaving(true); try { await onCreate(d); setD({ kind: "phone", duration_min: 45, status: "scheduled" }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Schedule interview</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <L label="Title"><Input value={d.title ?? ""} onChange={(e) => setD((p) => ({ ...p, title: e.target.value }))} autoFocus placeholder="Technical round" /></L>
          <div className="grid grid-cols-2 gap-2">
            <L label="Type"><select value={d.kind} onChange={(e) => setD((p) => ({ ...p, kind: e.target.value as Interview["kind"] }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm capitalize">{INTERVIEW_KIND.map((k) => <option key={k} value={k}>{k}</option>)}</select></L>
            <L label="Duration (min)"><Input type="number" value={d.duration_min ?? 45} onChange={(e) => setD((p) => ({ ...p, duration_min: Number(e.target.value) }))} /></L>
          </div>
          <L label="When"><Input type="datetime-local" onChange={(e) => setD((p) => ({ ...p, scheduled_at: e.target.value ? new Date(e.target.value).toISOString() : null }))} /></L>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Schedule</Button></div>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------- Avancement (pipeline)
// Drag-and-drop kanban: one column per stage, cards show source + AI fit + rating.
function PipelineTab({ opening }: { opening: Opening }) {
  const queryClient = useQueryClient();
  const { data: stages } = useStages(opening.id);
  const { data: candidates } = useCandidates(opening.id);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);

  const byStage = useMemo(() => {
    const m: Record<string, Candidate[]> = {};
    (stages ?? []).forEach((s) => (m[s.id] = []));
    (candidates ?? []).forEach((c) => { if (c.stage_id && m[c.stage_id]) m[c.stage_id].push(c); });
    return m;
  }, [stages, candidates]);

  async function move(id: string, stageId: string) {
    const c = (candidates ?? []).find((x) => x.id === id);
    if (!c || c.stage_id === stageId) return;
    // Optimistic update so the card jumps immediately.
    queryClient.setQueryData<Candidate[]>(["hr_opening_candidates", opening.id], (prev) =>
      (prev ?? []).map((x) => (x.id === id ? { ...x, stage_id: stageId } : x)));
    await supabase.from("hr_candidates").update({ stage_id: stageId }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["hr_opening_candidates", opening.id] });
  }

  if (!stages || stages.length === 0) return <EmptyState icon={GitBranch} title="No pipeline" description="Configure stages in the ATS settings tab." />;

  return (
    <>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {stages.map((s) => {
          const list = byStage[s.id] ?? [];
          return (
            <div
              key={s.id}
              onDragOver={(e) => { e.preventDefault(); setOverStage(s.id); }}
              onDragLeave={() => setOverStage((p) => (p === s.id ? null : p))}
              onDrop={() => { if (dragId) move(dragId, s.id); setDragId(null); setOverStage(null); }}
              className={cn("flex w-64 shrink-0 flex-col rounded-lg border bg-muted/20 p-2 transition-colors",
                overStage === s.id ? "border-primary bg-primary/5" : "border-border")}
            >
              <div className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium">
                <span className={cn("h-2 w-2 rounded-full", STAGE_KIND_ACCENT[s.kind])} /> {s.name}
                <span className="ml-auto rounded bg-muted px-1.5 text-muted-foreground">{list.length}</span>
              </div>
              <div className="min-h-[40px] space-y-2">
                {list.map((c) => (
                  <div
                    key={c.id}
                    draggable
                    onDragStart={() => setDragId(c.id)}
                    onDragEnd={() => { setDragId(null); setOverStage(null); }}
                    onClick={() => setSelected(c)}
                    className={cn("cursor-grab rounded-md border border-border bg-card p-2.5 active:cursor-grabbing hover:border-primary/40",
                      dragId === c.id && "opacity-50")}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <span className="truncate text-sm font-medium">{c.full_name}</span>
                      {c.ai_score != null && <FitBadge score={c.ai_score} />}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                      {c.source && <span className="rounded bg-muted px-1.5 py-0.5">{c.source}</span>}
                      {c.rating ? <span className="text-amber-500">{c.rating}★</span> : null}
                    </div>
                  </div>
                ))}
                {list.length === 0 && <div className="rounded-md border border-dashed border-border/60 py-3 text-center text-[11px] text-muted-foreground">Drop here</div>}
              </div>
            </div>
          );
        })}
      </div>
      {selected && <CandidateDrawer candidate={selected} opening={opening} stages={stages} onClose={() => setSelected(null)} />}
    </>
  );
}

// ------------------------------------------------------------ ATS settings tab
function AtsTab({ opening }: { opening: Opening }) {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const { data: stages } = useStages(opening.id);
  const { data: criteria } = useQuery({
    queryKey: ["hr_criteria", opening.id],
    queryFn: async () => {
      const { data } = await supabase.from("hr_scorecard_criteria").select("*").eq("opening_id", opening.id).order("position");
      return (data ?? []) as Criterion[];
    },
  });
  const [newStage, setNewStage] = useState("");
  const [newCrit, setNewCrit] = useState("");

  async function addStage() {
    if (!newStage.trim() || !workspaceId || !projectId) return;
    const pos = (stages ?? []).length;
    await supabase.from("hr_pipeline_stages").insert({ opening_id: opening.id, workspace_id: workspaceId, project_id: projectId, name: newStage.trim(), position: pos, kind: "middle" });
    setNewStage(""); queryClient.invalidateQueries({ queryKey: ["hr_stages", opening.id] });
  }
  async function removeStage(id: string) { await supabase.from("hr_pipeline_stages").delete().eq("id", id); queryClient.invalidateQueries({ queryKey: ["hr_stages", opening.id] }); }
  async function moveStage(s: Stage, dir: -1 | 1) {
    const list = stages ?? []; const i = list.findIndex((x) => x.id === s.id); const j = i + dir;
    if (j < 0 || j >= list.length) return;
    await supabase.from("hr_pipeline_stages").update({ position: list[j].position }).eq("id", s.id);
    await supabase.from("hr_pipeline_stages").update({ position: s.position }).eq("id", list[j].id);
    queryClient.invalidateQueries({ queryKey: ["hr_stages", opening.id] });
  }
  async function addCrit() {
    if (!newCrit.trim() || !workspaceId || !projectId) return;
    const pos = (criteria ?? []).length;
    await supabase.from("hr_scorecard_criteria").insert({ opening_id: opening.id, workspace_id: workspaceId, project_id: projectId, label: newCrit.trim(), weight: 1, position: pos });
    setNewCrit(""); queryClient.invalidateQueries({ queryKey: ["hr_criteria", opening.id] });
  }
  async function setWeight(id: string, weight: number) { await supabase.from("hr_scorecard_criteria").update({ weight }).eq("id", id); queryClient.invalidateQueries({ queryKey: ["hr_criteria", opening.id] }); }
  async function removeCrit(id: string) { await supabase.from("hr_scorecard_criteria").delete().eq("id", id); queryClient.invalidateQueries({ queryKey: ["hr_criteria", opening.id] }); }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Pipeline stages */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><GitBranch className="h-4 w-4" /> Pipeline stages</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {(stages ?? []).map((s, i) => (
            <div key={s.id} className="flex items-center gap-2 rounded-md border border-border p-2">
              <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
              <span className={cn("h-2 w-2 rounded-full", STAGE_KIND_ACCENT[s.kind])} />
              <span className="flex-1 text-sm">{s.name}</span>
              <button disabled={i === 0} onClick={() => moveStage(s, -1)} className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"><ChevronUp className="h-3.5 w-3.5" /></button>
              <button disabled={i === (stages ?? []).length - 1} onClick={() => moveStage(s, 1)} className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"><ChevronDown className="h-3.5 w-3.5" /></button>
              <button onClick={() => removeStage(s.id)} className="rounded p-1 text-destructive hover:bg-destructive/10"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <div className="flex gap-2">
            <Input value={newStage} onChange={(e) => setNewStage(e.target.value)} placeholder="New stage…" className="h-8" onKeyDown={(e) => e.key === "Enter" && addStage()} />
            <Button size="sm" onClick={addStage}><Plus className="h-3.5 w-3.5" /></Button>
          </div>
        </CardContent>
      </Card>

      {/* Scorecard criteria */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Star className="h-4 w-4" /> Scorecard criteria</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {(criteria ?? []).map((cr) => (
            <div key={cr.id} className="flex items-center gap-2 rounded-md border border-border p-2">
              <span className="flex-1 text-sm">{cr.label}</span>
              <label className="text-[10px] text-muted-foreground">weight</label>
              <select value={cr.weight} onChange={(e) => setWeight(cr.id, Number(e.target.value))} className="rounded border border-input bg-background px-1 py-0.5 text-xs">
                {[1, 2, 3, 4, 5].map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
              <button onClick={() => removeCrit(cr.id)} className="rounded p-1 text-destructive hover:bg-destructive/10"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <div className="flex gap-2">
            <Input value={newCrit} onChange={(e) => setNewCrit(e.target.value)} placeholder="New criterion…" className="h-8" onKeyDown={(e) => e.key === "Enter" && addCrit()} />
            <Button size="sm" onClick={addCrit}><Plus className="h-3.5 w-3.5" /></Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function L({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (<div className={full ? "col-span-2" : ""}><label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>{children}</div>);
}
