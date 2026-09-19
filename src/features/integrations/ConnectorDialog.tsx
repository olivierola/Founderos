import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ArrowSquareOutIcon as ExternalLink,
  CircleNotchIcon as Loader2,
  SlidersHorizontalIcon as Settings2,
  XIcon as X,
  LightningIcon as Zap,
  ArrowUpRightIcon as ArrowUpRight,
  EyeIcon as Eye,
} from "@phosphor-icons/react";
import {
  Dialog,
  DialogPortal,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { callEdge } from "@/lib/edge";
import type { ProviderDef } from "@/lib/providers";
import { connectorActionsMeta } from "./connectorActionsCatalog";

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
  const actions = connectorActionsMeta(provider.slug);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        {/* Dim overlay WITHOUT blur — the page behind stays sharp. */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        {/* Right-side, full-height drawer that slides in from the right. */}
        <DialogPrimitive.Content
          className="fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right"
        >
          {/* Header */}
          <div className="flex items-start gap-3 border-b border-border px-5 py-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary">
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle>Connect {provider.name}</DialogTitle>
              <DialogDescription>{provider.description}</DialogDescription>
            </div>
            <DialogPrimitive.Close className="rounded-md text-muted-foreground transition-colors hover:text-foreground">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>

          {/* Scrollable body */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
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

            {actions.length > 0 && (
              <div className="space-y-2 rounded-md border border-border bg-secondary/20 p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <Zap className="h-3.5 w-3.5 text-muted-foreground" />
                  Actions accordées ({actions.length})
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Une fois connecté, un agent pourra effectuer ces actions via l'API officielle de {provider.name}.
                </p>
                <ul className="space-y-1.5">
                  {actions.map((a) => (
                    <li key={a.name} className="flex items-start gap-2">
                      <span
                        className={
                          "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded " +
                          (a.write ? "bg-amber-500/15 text-amber-500" : "bg-emerald-500/15 text-emerald-500")
                        }
                        title={a.write ? "Écriture — action sortante" : "Lecture seule"}
                      >
                        {a.write ? <ArrowUpRight className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      </span>
                      <div className="min-w-0">
                        <code className="text-xs font-medium text-foreground">{a.name}</code>
                        <span className="ml-1.5 text-[11px] text-muted-foreground">{a.description}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Footer pinned at the bottom of the full-height drawer */}
          <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Connect
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
