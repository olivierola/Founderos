import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callEdge } from "@/lib/edge";

const CATEGORIES = ["infra", "hosting", "database", "ai", "email", "analytics", "monitoring", "storage", "other"];

interface AddCostDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  projectId: string;
  onSaved?: () => void;
}

export function AddCostDialog({ open, onOpenChange, workspaceId, projectId, onSaved }: AddCostDialogProps) {
  const [provider, setProvider] = useState("");
  const [category, setCategory] = useState("infra");
  const [amountEur, setAmountEur] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [note, setNote] = useState("");
  const [recurrence, setRecurrence] = useState<"one_off" | "recurring">("one_off");
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setProvider("");
    setCategory("infra");
    setAmountEur("");
    setPeriodStart("");
    setNote("");
    setRecurrence("one_off");
    setInterval("month");
    setError(null);
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const cents = Math.round(parseFloat(amountEur) * 100);
      if (!provider || !cents || Number.isNaN(cents)) {
        setError("Provider and amount are required");
        setSubmitting(false);
        return;
      }
      await callEdge("record-cost", {
        workspace_id: workspaceId,
        project_id: projectId,
        provider,
        category,
        amount_cents: cents,
        currency: "eur",
        period_start: periodStart || null,
        recurrence,
        recurrence_interval: recurrence === "recurring" ? interval : null,
        note: note || null,
      });
      reset();
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" /> Add a cost
          </DialogTitle>
          <DialogDescription>
            Manual entry — useful when a provider doesn't expose a cost API yet.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Provider</label>
            <Input placeholder="e.g. vercel, supabase, openai" value={provider} onChange={(e) => setProvider(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="flex h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Amount (€)</label>
              <Input type="number" step="0.01" placeholder="49.00" value={amountEur} onChange={(e) => setAmountEur(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Cost type</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setRecurrence("one_off")}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${
                  recurrence === "one_off"
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:bg-secondary"
                }`}
              >
                One-off
              </button>
              <button
                type="button"
                onClick={() => setRecurrence("recurring")}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${
                  recurrence === "recurring"
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:bg-secondary"
                }`}
              >
                Recurring
              </button>
            </div>
          </div>

          {recurrence === "recurring" && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Billing interval</label>
              <select
                value={interval}
                onChange={(e) => setInterval(e.target.value as "month" | "year")}
                className="flex h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="month">Monthly</option>
                <option value="year">Yearly</option>
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">
              {recurrence === "recurring" ? "Start date (optional)" : "Date (optional)"}
            </label>
            <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Note (optional)</label>
            <Input placeholder="Pro plan upgrade" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Save cost
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
