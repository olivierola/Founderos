import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { callEdge } from "@/lib/edge";

interface ActionField {
  key: string;
  label: string;
  placeholder?: string;
  type?: "text" | "number";
  required?: boolean;
}

export interface AdminActionConfig {
  action_type: string;
  title: string;
  description: string;
  risk: "low" | "medium" | "high" | "critical";
  fields: ActionField[];
  /** Confirm text the user must type for high-risk actions */
  typeToConfirm?: string;
}

interface AdminActionModalProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  action: AdminActionConfig | null;
  workspaceId: string;
  projectId: string;
  initialValues?: Record<string, string | number>;
  onSuccess?: (result: unknown) => void;
}

export function AdminActionModal({
  open,
  onOpenChange,
  action,
  workspaceId,
  projectId,
  initialValues,
  onSuccess,
}: AdminActionModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    Object.entries(initialValues ?? {}).forEach(([k, v]) => (out[k] = String(v)));
    return out;
  });
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!action) return null;

  const isHighRisk = action.risk === "high" || action.risk === "critical";
  const expectedConfirm = action.typeToConfirm ?? "CONFIRM";
  const confirmOk = !isHighRisk || confirmText.trim() === expectedConfirm;

  async function handleSubmit() {
    if (!action) return;
    if (!confirmOk) {
      setError(`Type "${expectedConfirm}" to confirm.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      action.fields.forEach((f) => {
        const raw = values[f.key] ?? "";
        payload[f.key] = f.type === "number" ? Number(raw) : raw;
      });
      const res = await callEdge<{ ok: boolean; result?: unknown }>("execute-admin-action", {
        workspace_id: workspaceId,
        project_id: projectId,
        action_type: action.action_type,
        payload,
        confirm: true,
      });
      setConfirmText("");
      setValues({});
      onOpenChange(false);
      onSuccess?.(res.result);
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
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-destructive/15 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <DialogTitle className="flex items-center gap-2">
                {action.title}
                <Badge variant={isHighRisk ? "destructive" : "warning"}>{action.risk}</Badge>
              </DialogTitle>
              <DialogDescription>{action.description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3">
          {action.fields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <label htmlFor={f.key} className="text-xs text-muted-foreground">
                {f.label}
              </label>
              <Input
                id={f.key}
                type={f.type ?? "text"}
                placeholder={f.placeholder}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            </div>
          ))}

          {isHighRisk && (
            <div className="space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <label className="text-xs text-destructive">
                Type <span className="font-mono font-semibold">{expectedConfirm}</span> to confirm
              </label>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={expectedConfirm}
              />
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={isHighRisk ? "destructive" : "default"} onClick={handleSubmit} disabled={submitting || !confirmOk}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Execute action
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
