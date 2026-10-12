// Administration → Installation (G4) : les réglages de l'installation et le
// diagnostic de chaque brique.
//
// Servie par le backend Express (dossier backend/, fonction native
// installation-admin) : les réglages s'appliquent à ce backend, et le
// diagnostic teste ce qu'il voit. L'environnement garde la priorité : un
// réglage fixé par une variable apparaît verrouillé. Les secrets ne passent
// jamais par cet écran, qui dit seulement s'ils sont présents.
import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowsClockwiseIcon as Run, CircleNotchIcon as Loader2, LockSimpleIcon as Lock, CheckCircleIcon as Ok,
  WarningIcon as Warn, XCircleIcon as Ko, MinusCircleIcon as Skip,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ToastProvider";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import { Pill, SectionTitle, inputCls, selectCls, type Tone } from "@/features/custom-connectors/ui";

type Source = "env" | "installation" | "default" | "unset";
interface Setting {
  key: string; label: string; group: "llm" | "connections" | "approvals" | "sso"; hint?: string;
  options?: string[]; expects?: string; default?: string;
  value: string; source: Source; locked: boolean; stored: string | null;
}
interface Status {
  ok: boolean;
  is_admin: boolean;
  can_claim: boolean;
  via: string | null;
  owner_workspace_id: string | null;
  settings?: Setting[];
  secrets?: Array<{ key: string; label: string; present: boolean; detail?: string }>;
  runtime?: { functions_url: string; mgmt_port: number; sso_mode: string; gateway_mode: string };
  history?: Array<{ key: string; old_value: string | null; new_value: string | null; changed_at: string }>;
}
interface Check { id: string; label: string; status: "ok" | "warn" | "error" | "skipped"; detail: string; fix?: string; ms?: number }

const GROUPS: Array<{ id: Setting["group"]; title: string }> = [
  { id: "llm", title: "Passerelle LLM" },
  { id: "connections", title: "Connexions" },
  { id: "approvals", title: "Approbations et liens" },
  { id: "sso", title: "SSO" },
];
const SOURCE: Record<Source, { label: string; tone: Tone }> = {
  env: { label: "environnement", tone: "violet" },
  installation: { label: "réglé ici", tone: "blue" },
  default: { label: "défaut", tone: "muted" },
  unset: { label: "non réglé", tone: "muted" },
};
const CHECK: Record<Check["status"], { icon: ReactNode; tone: Tone; label: string }> = {
  ok: { icon: <Ok className="h-4 w-4 text-emerald-600" />, tone: "green", label: "OK" },
  warn: { icon: <Warn className="h-4 w-4 text-amber-500" />, tone: "amber", label: "À voir" },
  error: { icon: <Ko className="h-4 w-4 text-red-600" />, tone: "red", label: "En panne" },
  skipped: { icon: <Skip className="h-4 w-4 text-muted-foreground" />, tone: "muted", label: "Sans objet" },
};

export function InstallationPage() {
  const { workspaceId } = useCurrentContext();
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ["installation-admin"];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => callEdge<Status>("installation-admin", { action: "status" }),
    retry: false,
  });

  async function claim() {
    try {
      await callEdge<Status>("installation-admin", { action: "claim", workspace_id: workspaceId });
      toast.success("Installation rattachée à cette organisation");
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error("Revendication refusée", e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <PageHeader
        title="Installation"
        description="Les réglages de cette installation et l'état de chaque brique. L'environnement garde la priorité : une installation pilotée par GitOps garde la main."
      />
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : error || !data ? (
        <Notice title="Servie par le backend FounderOS">
          Cette page parle au backend Express de l'installation (dossier backend/, VITE_API_URL côté interface). Sans lui, les réglages se font
          dans les variables d'environnement des fonctions. {error instanceof Error ? `(${error.message})` : ""}
        </Notice>
      ) : !data.is_admin ? (
        data.can_claim ? (
          <Notice title="Installation neuve">
            Personne n'administre encore cette installation, et votre organisation est la seule : rattachez-la pour régler l'installation.
            <span className="mt-3 block"><Button size="sm" onClick={claim}>Rattacher l'installation à cette organisation</Button></span>
          </Notice>
        ) : (
          <Notice title="Réservé aux administrateurs de l'installation">
            Les adresses de INSTALLATION_ADMINS, ou les owners et admins de l'organisation propriétaire de l'installation.
          </Notice>
        )
      ) : (
        <InstallationAdmin status={data} workspaceId={workspaceId!} onSaved={() => queryClient.invalidateQueries({ queryKey: key })} />
      )}
    </div>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="max-w-2xl rounded-xl border border-border p-5">
      <div className="text-sm font-medium">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function InstallationAdmin({ status, workspaceId, onSaved }: { status: Status; workspaceId: string; onSaved: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [running, setRunning] = useState(false);
  const settings = status.settings ?? [];
  const dirty = useMemo(() => Object.entries(draft).filter(([k, v]) => (settings.find((s) => s.key === k)?.stored ?? "") !== v), [draft, settings]);

  async function diagnose() {
    setRunning(true);
    try {
      const out = await callEdge<{ checks: Check[] }>("installation-admin", { action: "diagnose", workspace_id: workspaceId });
      setChecks(out.checks);
    } catch (e) {
      toast.error("Diagnostic impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }
  async function save() {
    setSaving(true);
    try {
      const out = await callEdge<{ changed: string[] }>("installation-admin", { action: "save", values: Object.fromEntries(dirty) });
      toast.success(out.changed.length ? `${out.changed.length} réglage(s) appliqué(s)` : "Rien à changer", "Appliqués aussitôt par ce backend ; les autres réplicas suivent en moins d'une minute.");
      setDraft({});
      onSaved();
    } catch (e) {
      toast.error("Réglages refusés", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <section>
        <SectionTitle aside={<Button size="sm" onClick={diagnose} disabled={running}>
          {running ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Run className="mr-1 h-3.5 w-3.5" />} Lancer le diagnostic
        </Button>}>
          Diagnostic
        </SectionTitle>
        {!checks ? (
          <p className="text-sm text-muted-foreground">
            Teste la base et ses migrations, le chiffrement, la clé de signature et son JWKS public, la passerelle LLM (un appel court),
            les fournisseurs SSO, la garde SSO, les relais et les serveurs MCP de cette organisation, les métriques et OPA.
          </p>
        ) : (
          <div className="divide-y divide-border rounded-xl border border-border">
            {checks.map((c) => (
              <div key={c.id} className="flex gap-3 px-4 py-3">
                <div className="pt-0.5">{CHECK[c.status].icon}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{c.label}</span>
                    <Pill tone={CHECK[c.status].tone}>{CHECK[c.status].label}</Pill>
                    {c.ms !== undefined && <span className="text-[10px] text-muted-foreground">{c.ms} ms</span>}
                  </div>
                  <p className="mt-0.5 break-words text-xs text-muted-foreground">{c.detail}</p>
                  {c.fix && c.status !== "ok" && <p className="mt-0.5 text-xs text-foreground">→ {c.fix}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle aside={<Button size="sm" onClick={save} disabled={saving || dirty.length === 0}>
          {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Enregistrer{dirty.length ? ` (${dirty.length})` : ""}
        </Button>}>
          Réglages
        </SectionTitle>
        <div className="space-y-6">
          {GROUPS.map((g) => (
            <div key={g.id}>
              <div className="mb-2 text-xs font-medium text-muted-foreground">{g.title}</div>
              <div className="grid gap-3 lg:grid-cols-2">
                {settings.filter((s) => s.group === g.id).map((s) => {
                  const value = draft[s.key] ?? (s.locked ? s.value : s.stored ?? "");
                  return (
                    <label key={s.key} className="block rounded-lg border border-border p-3 text-xs">
                      <span className="mb-1 flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{s.label}</span>
                        <Pill tone={SOURCE[s.source].tone}>{SOURCE[s.source].label}</Pill>
                        {s.locked && <Lock className="h-3 w-3 text-muted-foreground" aria-label="Fixé par l'environnement" />}
                      </span>
                      {s.options ? (
                        <select className={cn(selectCls, "h-8 text-xs")} disabled={s.locked} value={value}
                          onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}>
                          {s.options.map((o) => <option key={o} value={o}>{o || "(vide)"}</option>)}
                        </select>
                      ) : (
                        <input className={cn(inputCls, "h-8 font-mono text-xs")} disabled={s.locked} value={value}
                          placeholder={s.default ?? s.expects ?? ""}
                          onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))} />
                      )}
                      <span className="mt-1 block font-mono text-[10px] text-muted-foreground">{s.key}</span>
                      {s.hint && <span className="mt-0.5 block text-[10px] text-muted-foreground">{s.hint}</span>}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle>Secrets</SectionTitle>
          <p className="mb-2 text-xs text-muted-foreground">Dans l'environnement ou Vault, jamais ici. Seule leur présence est vérifiée.</p>
          <div className="divide-y divide-border rounded-xl border border-border">
            {(status.secrets ?? []).map((s) => (
              <div key={s.key} className="flex items-center gap-2 px-3 py-2 text-xs">
                <span className="min-w-0 flex-1">
                  {s.label}
                  <span className="block font-mono text-[10px] text-muted-foreground">{s.key}</span>
                  {s.detail && <span className="block text-[10px] text-red-600">{s.detail}</span>}
                </span>
                <Pill tone={s.present ? (s.detail ? "red" : "green") : "muted"}>{s.present ? "présent" : "absent"}</Pill>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-6">
          <div>
            <SectionTitle>Exécution</SectionTitle>
            <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Backend</dt><dd className="font-mono">{status.runtime?.functions_url}</dd>
              <dt className="text-muted-foreground">Métriques</dt><dd>{status.runtime?.mgmt_port ? `:${status.runtime.mgmt_port}/metrics` : "désactivées"}</dd>
              <dt className="text-muted-foreground">SSO</dt><dd>{status.runtime?.sso_mode === "shared" ? "partagé (domaines vérifiés)" : status.runtime?.sso_mode === "dedicated" ? "dédié" : "fermé"}</dd>
              <dt className="text-muted-foreground">Contrôle des JWT</dt><dd>{status.runtime?.gateway_mode}</dd>
              <dt className="text-muted-foreground">Administrée par</dt><dd>{status.via ?? "?"}</dd>
            </dl>
          </div>
          <div>
            <SectionTitle>Derniers changements</SectionTitle>
            {(status.history ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">Aucun changement depuis cet écran.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {status.history!.map((h, i) => (
                  <li key={i} className="break-words">
                    <span className="text-muted-foreground">{new Date(h.changed_at).toLocaleString("fr-FR")}</span>{" "}
                    <span className="font-mono">{h.key}</span> : {h.old_value ?? "(vide)"} → {h.new_value ?? "(vide)"}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
