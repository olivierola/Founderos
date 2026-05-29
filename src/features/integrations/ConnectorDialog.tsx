import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { callEdge } from "@/lib/edge";
import type { ProviderDef } from "@/lib/providers";

interface ConnectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderDef | null;
  workspaceId: string;
  projectId: string;
  onConnected?: () => void;
}

export function ConnectorDialog({
  open,
  onOpenChange,
  provider,
  workspaceId,
  projectId,
  onConnected,
}: ConnectorDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!provider) return;
    setSubmitting(true);
    setError(null);
    try {
      await callEdge("connect-provider", {
        workspace_id: workspaceId,
        project_id: projectId,
        provider: provider.slug,
        payload: values,
      });
      setValues({});
      onOpenChange(false);
      onConnected?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (!provider) return null;
  const Icon = provider.icon;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-secondary">
              <Icon className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle>Connect {provider.name}</DialogTitle>
              <DialogDescription>{provider.description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3">
          {provider.fields.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor={field.key} className="text-xs text-muted-foreground">
                  {field.label}
                </label>
                {field.helpUrl && (
                  <a
                    href={field.helpUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Get key <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              <Input
                id={field.key}
                type={field.secret ? "password" : "text"}
                placeholder={field.placeholder}
                value={values[field.key] ?? ""}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
              />
            </div>
          ))}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Connect
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
