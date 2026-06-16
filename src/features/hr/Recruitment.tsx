import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Briefcase, Loader2, Plus, MapPin, Users, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { type Opening, OPENING_STATUS } from "./recruitmentTypes";

export function RecruitmentPage() {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: openings, isLoading } = useQuery({
    queryKey: ["hr_openings", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("hr_job_openings").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Opening[];
    },
  });
  // Candidate counts per opening.
  const ids = (openings ?? []).map((o) => o.id);
  const { data: counts } = useQuery({
    queryKey: ["hr_opening_counts", ids.sort().join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("hr_candidates").select("opening_id").in("opening_id", ids);
      const m: Record<string, number> = {};
      (data ?? []).forEach((c: any) => { if (c.opening_id) m[c.opening_id] = (m[c.opening_id] ?? 0) + 1; });
      return m;
    },
  });

  async function create(draft: Partial<Opening>) {
    if (!workspaceId || !projectId || !user) return;
    const { data, error } = await supabase.from("hr_job_openings")
      .insert({ ...draft, workspace_id: workspaceId, project_id: projectId, created_by: user.id })
      .select("id").single();
    if (error) { alert(error.message); return; }
    // Seed default ATS pipeline stages for the new opening.
    const stages = [
      { name: "Applied", position: 0, kind: "applied" },
      { name: "Screening", position: 1, kind: "middle" },
      { name: "Interview", position: 2, kind: "interview" },
      { name: "Offer", position: 3, kind: "offer" },
      { name: "Hired", position: 4, kind: "hired" },
      { name: "Rejected", position: 5, kind: "rejected" },
    ].map((s) => ({ ...s, opening_id: data!.id, workspace_id: workspaceId, project_id: projectId }));
    await supabase.from("hr_pipeline_stages").insert(stages);
    queryClient.invalidateQueries({ queryKey: ["hr_openings", projectId] });
    setOpen(false);
    navigate(`/app/${workspaceSlug}/${projectSlug}/hr/opening/${data!.id}/overview`);
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Recruitment" description="Job openings and your tailored ATS per role." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New opening</Button>} />
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (openings ?? []).length === 0 ? <EmptyState icon={Briefcase} title="No openings yet" description="Create a job opening — each gets its own configurable pipeline." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New opening</Button>} />
        : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {(openings ?? []).map((o) => {
              const meta = OPENING_STATUS[o.status];
              return (
                <Card key={o.id} className="group cursor-pointer transition-colors hover:border-foreground/30"
                  onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/hr/opening/${o.id}/overview`)}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", meta.cls)}>{meta.label}</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                    <h3 className="mt-2 font-semibold leading-tight">{o.title}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {o.department && <span>{o.department}</span>}
                      {o.location && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{o.location}</span>}
                      <span className="capitalize">{o.employment_type.replace("_", " ")}</span>
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 border-t border-border pt-2 text-xs text-muted-foreground">
                      <Users className="h-3.5 w-3.5" /> {counts?.[o.id] ?? 0} candidates
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      <OpeningDialog open={open} onOpenChange={setOpen} onCreate={create} />
    </div>
  );
}

function OpeningDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: Partial<Opening>) => Promise<void> }) {
  const [d, setD] = useState<Partial<Opening>>({ status: "open", employment_type: "full_time" });
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.title?.trim()) return; setSaving(true); try { await onCreate(d); setD({ status: "open", employment_type: "full_time" }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>New job opening</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Fld label="Title" full><Input value={d.title ?? ""} onChange={(e) => setD((p) => ({ ...p, title: e.target.value }))} autoFocus placeholder="Senior Backend Engineer" /></Fld>
          <Fld label="Department"><Input value={d.department ?? ""} onChange={(e) => setD((p) => ({ ...p, department: e.target.value }))} /></Fld>
          <Fld label="Location"><Input value={d.location ?? ""} onChange={(e) => setD((p) => ({ ...p, location: e.target.value }))} /></Fld>
          <Fld label="Employment type">
            <select value={d.employment_type} onChange={(e) => setD((p) => ({ ...p, employment_type: e.target.value }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {["full_time", "part_time", "contractor", "intern"].map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
            </select>
          </Fld>
          <Fld label="Salary range"><Input value={d.salary_range ?? ""} onChange={(e) => setD((p) => ({ ...p, salary_range: e.target.value }))} placeholder="€50k–70k" /></Fld>
          <Fld label="Description" full><textarea value={d.description ?? ""} onChange={(e) => setD((p) => ({ ...p, description: e.target.value }))} rows={3} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" /></Fld>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Create</Button></div>
      </DialogContent>
    </Dialog>
  );
}

function Fld({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (<div className={full ? "col-span-2" : ""}><label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>{children}</div>);
}
