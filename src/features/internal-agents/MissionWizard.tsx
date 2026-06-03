import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Loader2, Trash2, ChevronRight, ChevronLeft, Check,
  FileText, FileJson, FileCode, Link2, Paperclip, Target,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  type ExpectedDeliverable, type MissionPriority, type MissionSchedule,
  PRIORITY_META, loadWorkspaceMembers, memberLabel,
} from "./shared";

export interface MissionDraft {
  title: string;
  brief: string;
  acceptance_criteria: string;
  expected_deliverables: ExpectedDeliverable[];
  priority: MissionPriority;
  due_date: string | null;
  assigned_to: string | null;
  tags: string[];
  schedule: MissionSchedule;
}

const EMPTY_DRAFT: MissionDraft = {
  title: "",
  brief: "",
  acceptance_criteria: "",
  expected_deliverables: [],
  priority: "normal",
  due_date: null,
  assigned_to: null,
  tags: [],
  schedule: null,
};

const DELIVERABLE_PRESETS: Array<{ kind: string; name: string; icon: any; hint: string }> = [
  { kind: "markdown", name: "Written report", icon: FileText, hint: "A markdown document" },
  { kind: "json", name: "Structured data", icon: FileJson, hint: "A JSON payload" },
  { kind: "code", name: "Code snippet", icon: FileCode, hint: "A block of code" },
  { kind: "url", name: "Link / resource", icon: Link2, hint: "A URL to publish or reference" },
  { kind: "file", name: "File attachment", icon: Paperclip, hint: "An uploaded artifact" },
];

const STEPS = ["Brief", "Deliverables", "Assignment"] as const;

export function MissionWizard({
  open,
  onOpenChange,
  workspaceId,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string | null;
  initial?: Partial<MissionDraft>;
  onSubmit: (draft: MissionDraft) => Promise<void> | void;
}) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<MissionDraft>({ ...EMPTY_DRAFT, ...initial });
  const [saving, setSaving] = useState(false);
  const [tagInput, setTagInput] = useState("");

  const { data: members } = useQuery({
    queryKey: ["ws_members_for_assign", workspaceId],
    enabled: !!workspaceId && open,
    queryFn: () => loadWorkspaceMembers(workspaceId!),
  });

  useEffect(() => {
    if (open) {
      setStep(0);
      setDraft({ ...EMPTY_DRAFT, ...initial });
      setTagInput("");
    }
  }, [open]);

  function set<K extends keyof MissionDraft>(key: K, value: MissionDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  const canNext =
    step === 0 ? draft.title.trim().length > 0 : true;

  async function submit() {
    setSaving(true);
    try {
      await onSubmit({ ...draft, title: draft.title.trim() });
    } finally {
      setSaving(false);
    }
  }

  function addPreset(p: { kind: string; name: string }) {
    set("expected_deliverables", [
      ...draft.expected_deliverables,
      { kind: p.kind, name: p.name },
    ]);
  }
  function addTag() {
    const t = tagInput.trim().toLowerCase();
    if (t && !draft.tags.includes(t)) set("tags", [...draft.tags, t]);
    setTagInput("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="h-4 w-4" /> {initial?.title ? "Edit mission" : "Assign a mission"}
          </DialogTitle>
        </DialogHeader>

        {/* Stepper */}
        <div className="flex items-center gap-2">
          {STEPS.map((label, i) => (
            <div key={label} className="flex flex-1 items-center gap-2">
              <button
                onClick={() => i <= step && setStep(i)}
                className={cn(
                  "flex items-center gap-1.5 text-xs font-medium transition-colors",
                  i === step ? "text-foreground" : i < step ? "text-foreground/70" : "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full text-[10px]",
                    i === step ? "bg-primary text-primary-foreground"
                      : i < step ? "bg-emerald-500 text-white" : "bg-muted",
                  )}
                >
                  {i < step ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                {label}
              </button>
              {i < STEPS.length - 1 && <div className="h-px flex-1 bg-border" />}
            </div>
          ))}
        </div>

        <div className="min-h-[320px] py-2">
          {step === 0 && (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Mission title</label>
                <Input
                  value={draft.title}
                  onChange={(e) => set("title", e.target.value)}
                  autoFocus
                  placeholder="e.g. Weekly competitor digest"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Brief — what should the agent do?</label>
                <textarea
                  value={draft.brief}
                  onChange={(e) => set("brief", e.target.value)}
                  rows={6}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Describe the task in detail: inputs, sources, tone, constraints…"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Acceptance criteria — what counts as done?</label>
                <textarea
                  value={draft.acceptance_criteria}
                  onChange={(e) => set("acceptance_criteria", e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="e.g. Covers the top 5 competitors with a source link each."
                />
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Tell the agent what artifacts to produce. Click a preset to add it, then rename as needed.
              </p>
              <div className="flex flex-wrap gap-2">
                {DELIVERABLE_PRESETS.map((p) => {
                  const Icon = p.icon;
                  return (
                    <button
                      key={p.kind + p.name}
                      onClick={() => addPreset(p)}
                      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-muted/40"
                      title={p.hint}
                    >
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" /> {p.name}
                    </button>
                  );
                })}
              </div>

              {draft.expected_deliverables.length === 0 ? (
                <p className="rounded border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                  No deliverables yet. Add at least one so results are structured.
                </p>
              ) : (
                <div className="space-y-2">
                  {draft.expected_deliverables.map((d, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-md border border-border p-2">
                      <select
                        value={d.kind}
                        onChange={(e) => {
                          const next = [...draft.expected_deliverables];
                          next[i] = { ...d, kind: e.target.value };
                          set("expected_deliverables", next);
                        }}
                        className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                      >
                        {DELIVERABLE_PRESETS.map((p) => (
                          <option key={p.kind} value={p.kind}>{p.kind}</option>
                        ))}
                      </select>
                      <Input
                        value={d.name}
                        onChange={(e) => {
                          const next = [...draft.expected_deliverables];
                          next[i] = { ...d, name: e.target.value };
                          set("expected_deliverables", next);
                        }}
                        placeholder="Name"
                        className="h-7 flex-1"
                      />
                      <Input
                        value={d.description ?? ""}
                        onChange={(e) => {
                          const next = [...draft.expected_deliverables];
                          next[i] = { ...d, description: e.target.value };
                          set("expected_deliverables", next);
                        }}
                        placeholder="Notes (optional)"
                        className="h-7 flex-1"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          set("expected_deliverables", draft.expected_deliverables.filter((_, j) => j !== i))
                        }
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Priority</label>
                  <div className="flex gap-1.5">
                    {(Object.keys(PRIORITY_META) as MissionPriority[]).map((p) => {
                      const meta = PRIORITY_META[p];
                      return (
                        <button
                          key={p}
                          onClick={() => set("priority", p)}
                          className={cn(
                            "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                            draft.priority === p
                              ? "border-foreground bg-foreground/5 font-medium"
                              : "border-border text-muted-foreground hover:bg-muted/40",
                          )}
                        >
                          <span className={cn("h-2 w-2 rounded-full", meta.dot)} /> {meta.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Due date</label>
                  <Input
                    type="date"
                    value={draft.due_date ? draft.due_date.slice(0, 10) : ""}
                    onChange={(e) => set("due_date", e.target.value ? new Date(e.target.value).toISOString() : null)}
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Owner (human responsible)</label>
                <select
                  value={draft.assigned_to ?? ""}
                  onChange={(e) => set("assigned_to", e.target.value || null)}
                  className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
                >
                  <option value="">Unassigned</option>
                  {(members ?? []).map((m) => (
                    <option key={m.user_id} value={m.user_id}>{memberLabel(m)}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Recurrence</label>
                <div className="flex gap-1.5">
                  {([null, "daily", "weekly", "monthly"] as MissionSchedule[]).map((s) => (
                    <button
                      key={s ?? "manual"}
                      onClick={() => set("schedule", s)}
                      className={cn(
                        "rounded-md border px-2.5 py-1.5 text-xs capitalize transition-colors",
                        draft.schedule === s
                          ? "border-foreground bg-foreground/5 font-medium"
                          : "border-border text-muted-foreground hover:bg-muted/40",
                      )}
                    >
                      {s ?? "Manual"}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Tags</label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {draft.tags.map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                      {t}
                      <button onClick={() => set("tags", draft.tags.filter((x) => x !== t))} className="text-muted-foreground hover:text-foreground">×</button>
                    </span>
                  ))}
                  <Input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
                    placeholder="Add tag…"
                    className="h-7 w-28"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div className="flex items-center justify-between border-t border-border pt-3">
          <Button variant="ghost" onClick={() => (step === 0 ? onOpenChange(false) : setStep(step - 1))}>
            {step === 0 ? "Cancel" : <><ChevronLeft className="mr-1 h-3.5 w-3.5" /> Back</>}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep(step + 1)} disabled={!canNext}>
              Next <ChevronRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button onClick={submit} disabled={saving || !draft.title.trim()}>
              {saving && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
              {initial?.title ? "Save mission" : "Create mission"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
