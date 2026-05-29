import { useEffect, useState } from "react";
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

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  confirmText?: string;
  /** If set, the user must type this exact string to enable the confirm button */
  typeToConfirm?: string;
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = "Confirm",
  typeToConfirm,
  destructive = true,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTyped("");
      setError(null);
    }
  }, [open]);

  const ok = !typeToConfirm || typed.trim() === typeToConfirm;

  async function handle() {
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
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
            {destructive && (
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-destructive/15 text-destructive">
                <AlertTriangle className="h-5 w-5" />
              </div>
            )}
            <div>
              <DialogTitle>{title}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
            </div>
          </div>
        </DialogHeader>
        {typeToConfirm && (
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">
              Type <span className="font-mono font-semibold text-foreground">{typeToConfirm}</span> to confirm
            </label>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={typeToConfirm} />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={handle} disabled={submitting || !ok}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmText}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
