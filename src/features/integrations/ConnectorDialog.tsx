import { useState } from "react";
import { ExternalLink, Loader2, Settings2 } from "lucide-react";
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

/* Provider-specific non-secret IDs that other edges (sync-deployments,
   propagate-credential) need to call the right project / site / service.
   These land in connectors.metadata, not in encrypted_credentials. */
interface MetadataField {
  key: string;
  label: string;
  placeholder?: string;
  helpUrl?: string;
}
const META_FIELDS: Record<string, MetadataField[]> = {
  vercel: [
    { key: "vercel_project_id", label: "Vercel project ID", placeholder: "prj_…", helpUrl: "https://vercel.com/docs/projects/overview#project-id" },
  ],
  netlify: [
    { key: "site_id", label: "Netlify site ID (optional)", placeholder: "12345678-aaaa-…" },
  ],
  render: [
    { key: "render_service_id", label: "Render service ID", placeholder: "srv_…" },
  ],
  cloudflare: [
    { key: "account_id", label: "Cloudflare account ID", placeholder: "0123abcd…" },
    { key: "pages_project", label: "Cloudflare Pages project name", placeholder: "my-app" },
    { key: "script_name", label: "Workers script name (optional)", placeholder: "my-worker" },
  ],
  railway: [
    { key: "railway_project_id", label: "Railway project ID", placeholder: "…" },
    { key: "railway_environment_id", label: "Railway environment ID", placeholder: "…" },
  ],
  firebase: [
    { key: "firebase_site", label: "Firebase Hosting site name", placeholder: "my-app" },
  ],
  fly: [
    { key: "fly_app", label: "Fly app name", placeholder: "my-app" },
  ],
  heroku: [
    { key: "heroku_app", label: "Heroku app name", placeholder: "my-app" },
  ],
  digitalocean: [
    { key: "droplet_id", label: "Droplet ID (optional, narrows actions)", placeholder: "12345" },
  ],
  hetzner: [
    { key: "hetzner_server_id", label: "Server ID (optional, narrows actions)", placeholder: "1234567" },
  ],
};

export function ConnectorDialog({
  open,
  onOpenChange,
  provider,
  workspaceId,
  projectId,
  onConnected,
}: ConnectorDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const metaFields = provider ? META_FIELDS[provider.slug] ?? [] : [];

  async function handleSubmit() {
    if (!provider) return;
    setSubmitting(true);
    setError(null);
    try {
      // Strip empty meta values so we don't overwrite existing metadata with "".
      const extraMetadata = Object.fromEntries(
        Object.entries(meta).filter(([, v]) => v && v.trim() !== ""),
      );
      await callEdge("connect-provider", {
        workspace_id: workspaceId,
        project_id: projectId,
        provider: provider.slug,
        payload: values,
        extra_metadata: extraMetadata,
      });
      setValues({});
      setMeta({});
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
          {metaFields.length > 0 && (
            <div className="space-y-2 rounded-md border border-border bg-secondary/30 p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
                Configuration (used to target the right project)
              </div>
              {metaFields.map((field) => (
                <div key={field.key} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label htmlFor={"meta-" + field.key} className="text-xs text-muted-foreground">
                      {field.label}
                    </label>
                    {field.helpUrl && (
                      <a
                        href={field.helpUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        Find it <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    )}
                  </div>
                  <Input
                    id={"meta-" + field.key}
                    placeholder={field.placeholder}
                    value={meta[field.key] ?? ""}
                    onChange={(e) => setMeta({ ...meta, [field.key]: e.target.value })}
                    className="h-9 font-mono text-xs"
                  />
                </div>
              ))}
            </div>
          )}

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
