// Administration → Approbations → Règles (G3, migration 0281).
//
// Une règle dit QUI approuve, COMBIEN de personnes et en COMBIEN de temps,
// pour une portée : type de connexion, connexion, environnement, risque,
// opérations. Pour un serveur MCP, le serveur décide de demander ; pour un
// outil interne, la règle impose aussi l'approbation. Sans règle : le
// comportement d'avant. Les owners et admins écrivent ; les membres lisent.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon as Plus, PencilSimpleIcon as Pencil, TrashIcon as Trash, CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ToastProvider";
import { useConfirm } from "@/components/ConfirmProvider";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Pill } from "@/features/custom-connectors/ui";

export interface ApprovalPolicyRow {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  connection_kind: "mcp" | "custom_connector" | null;
  connection_id: string | null;
  environment: "development" | "staging" | "production" | null;
  min_risk: "write" | "destructive";
  operations: string[];
  approver_roles: string[];
  approver_idp_roles: string[];
  quorum: number;
  ttl_minutes: number;
  fresh_login_minutes: number | null;
}

const ENV_LABEL: Record<string, string> = { development: "développement", staging: "recette", production: "production" };
const ROLE_LABEL: Record<string, string> = { owner: "propriétaire", admin: "admin", member: "membre" };

/** « 2 approbateurs distincts : « Ops » » — même texte que describeApprovers (approval-policy.ts). */
export function describeRule(rule: { roles?: string[]; idp_roles?: string[] } | null | undefined, quorum: number): string {
  const who = [
    ...(rule?.roles ?? []).map((r) => ROLE_LABEL[r] ?? r),
    ...(rule?.idp_roles ?? []).map((r) => `« ${r} »`),
  ].join(" ou ");
  return `${quorum} approbateur${quorum > 1 ? "s distincts" : ""} : ${who || "?"}`;
}

export function ApprovalPoliciesPanel({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ApprovalPolicyRow | "new" | null>(null);
  const key = ["approval-policies", workspaceId];

  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const [{ data: policies, error }, { data: mcp }, { data: connectors }] = await Promise.all([
        supabase.from("approval_policies")
          .select("id, name, enabled, priority, connection_kind, connection_id, environment, min_risk, operations, approver_roles, approver_idp_roles, quorum, ttl_minutes, fresh_login_minutes")
          .eq("workspace_id", workspaceId).order("priority").order("created_at"),
        supabase.from("mcp_servers").select("id, name, environment").eq("workspace_id", workspaceId).order("name"),
        supabase.from("custom_connectors").select("id, name, environment").eq("workspace_id", workspaceId).order("name"),
      ]);
      if (error) throw error;
      return {
        policies: (policies ?? []) as ApprovalPolicyRow[],
        mcp: (mcp ?? []) as Array<{ id: string; name: string; environment: string | null }>,
        connectors: (connectors ?? []) as Array<{ id: string; name: string; environment: string | null }>,
      };
    },
  });
  const nameOf = (p: ApprovalPolicyRow) => p.connection_id
    ? [...(data?.mcp ?? []), ...(data?.connectors ?? [])].find((c) => c.id === p.connection_id)?.name ?? "connexion supprimée"
    : null;

  async function toggle(p: ApprovalPolicyRow) {
    const { error } = await supabase.from("approval_policies").update({ enabled: !p.enabled, updated_at: new Date().toISOString() }).eq("id", p.id);
    if (error) toast.error(error.message);
    await queryClient.invalidateQueries({ queryKey: key });
  }
  async function remove(p: ApprovalPolicyRow) {
    if (!(await confirm(`Supprimer la règle « ${p.name} » ? Les demandes en cours gardent leur copie.`))) return;
    const { error } = await supabase.from("approval_policies").delete().eq("id", p.id);
    if (error) toast.error(error.message);
    await queryClient.invalidateQueries({ queryKey: key });
  }

  if (isLoading || !data) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-xs text-muted-foreground">
          La première règle qui s'applique décide : la plus petite priorité, puis la plus précise. Une règle de production ne
          vaut que pour une connexion déclarée en production. Sans règle, un serveur MCP garde le rôle IdP ai-ops-prd-approver
          (1 approbateur, 15 minutes), et un outil interne ne change pas. La personne au nom de qui l'agent agit n'approuve jamais.
        </p>
        {canEdit && (
          <Button size="sm" className="rounded-full" onClick={() => setEditing("new")}><Plus className="mr-1 h-4 w-4" /> Nouvelle règle</Button>
        )}
      </div>

      {data.policies.length === 0 && <p className="text-sm text-muted-foreground">Aucune règle : le comportement par défaut s'applique.</p>}
      {data.policies.map((p) => (
        <article key={p.id} className={cn("rounded-xl border bg-card p-4", p.enabled ? "border-border" : "border-dashed opacity-70")}>
          <header className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{p.name}</span>
            <Pill tone="muted">priorité {p.priority}</Pill>
            {!p.enabled && <Pill tone="muted">désactivée</Pill>}
            {canEdit && (
              <span className="ml-auto flex items-center gap-1">
                <button onClick={() => toggle(p)} className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted">{p.enabled ? "Désactiver" : "Activer"}</button>
                <button onClick={() => setEditing(p)} className="rounded p-1.5 text-muted-foreground hover:bg-muted" aria-label="Modifier"><Pencil className="h-3.5 w-3.5" /></button>
                <button onClick={() => remove(p)} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive" aria-label="Supprimer"><Trash className="h-3.5 w-3.5" /></button>
              </span>
            )}
          </header>
          <p className="text-xs text-muted-foreground">
            {p.connection_kind === "mcp" ? "Serveurs MCP" : p.connection_kind === "custom_connector" ? "Outils internes" : "Toutes les connexions"}
            {nameOf(p) ? ` · ${nameOf(p)}` : ""}
            {p.environment ? ` · ${ENV_LABEL[p.environment]}` : " · tout environnement"}
            {` · ${p.min_risk === "destructive" ? "actions irréversibles" : "écritures"}`}
            {p.operations.length ? ` · ${p.operations.join(", ")}` : ""}
          </p>
          <p className="mt-1 text-xs">
            {describeRule({ roles: p.approver_roles, idp_roles: p.approver_idp_roles }, p.quorum)} · sous {p.ttl_minutes} min
            {p.fresh_login_minutes ? ` · connexion SSO de moins de ${p.fresh_login_minutes} min pour voter` : ""}
          </p>
        </article>
      ))}

      {editing && (
        <PolicyForm
          workspaceId={workspaceId}
          policy={editing === "new" ? null : editing}
          mcp={data.mcp}
          connectors={data.connectors}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await queryClient.invalidateQueries({ queryKey: key }); }}
        />
      )}
    </div>
  );
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const inputCls = "h-8 w-full rounded-md border border-border bg-background px-2 text-sm";

function PolicyForm({ workspaceId, policy, mcp, connectors, onClose, onSaved }: {
  workspaceId: string;
  policy: ApprovalPolicyRow | null;
  mcp: Array<{ id: string; name: string; environment: string | null }>;
  connectors: Array<{ id: string; name: string; environment: string | null }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(policy?.name ?? "");
  const [priority, setPriority] = useState(String(policy?.priority ?? 100));
  const [kind, setKind] = useState<string>(policy?.connection_kind ?? "");
  const [connectionId, setConnectionId] = useState(policy?.connection_id ?? "");
  const [environment, setEnvironment] = useState<string>(policy?.environment ?? "");
  const [minRisk, setMinRisk] = useState<"write" | "destructive">(policy?.min_risk ?? "write");
  const [operations, setOperations] = useState((policy?.operations ?? []).join(", "));
  const [roles, setRoles] = useState<string[]>(policy?.approver_roles ?? []);
  const [idpRoles, setIdpRoles] = useState((policy?.approver_idp_roles ?? []).join(", "));
  const [quorum, setQuorum] = useState(String(policy?.quorum ?? 1));
  const [ttl, setTtl] = useState(String(policy?.ttl_minutes ?? 15));
  const [freshLogin, setFreshLogin] = useState(policy?.fresh_login_minutes ? String(policy.fresh_login_minutes) : "");
  const [saving, setSaving] = useState(false);

  const choices = kind === "mcp" ? mcp : kind === "custom_connector" ? connectors : [];
  const ops = list(operations);
  const idp = list(idpRoles);
  const issue = !name.trim() ? "Donnez un nom à la règle."
    : roles.length + idp.length === 0 ? "Choisissez au moins un rôle FounderOS ou un rôle / groupe de l'IdP."
    : ops.some((o) => /[^A-Za-z0-9_.:/ -]/.test(o)) ? "Opérations : lettres, chiffres et _ . : / - seulement."
    : !(Number(quorum) >= 1 && Number(quorum) <= 5) ? "Quorum : de 1 à 5."
    : !(Number(ttl) >= 1 && Number(ttl) <= 1440) ? "Échéance : de 1 à 1440 minutes."
    : !(Number(priority) >= 0 && Number(priority) <= 1000) ? "Priorité : de 0 à 1000."
    : freshLogin && !(Number(freshLogin) >= 1 && Number(freshLogin) <= 10080) ? "Connexion récente : de 1 à 10080 minutes, ou vide."
    : null;

  async function save() {
    if (issue) return;
    setSaving(true);
    try {
      const row = {
        name: name.trim(), priority: Number(priority),
        connection_kind: kind || null, connection_id: kind && connectionId ? connectionId : null,
        environment: environment || null, min_risk: minRisk, operations: ops,
        approver_roles: roles, approver_idp_roles: idp, quorum: Number(quorum), ttl_minutes: Number(ttl),
        fresh_login_minutes: freshLogin ? Number(freshLogin) : null,
        updated_at: new Date().toISOString(),
      };
      const { error } = policy
        ? await supabase.from("approval_policies").update(row).eq("id", policy.id)
        : await supabase.from("approval_policies").insert({ ...row, workspace_id: workspaceId });
      if (error) { toast.error(error.message); return; }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-primary/40 bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold">{policy ? "Modifier la règle" : "Nouvelle règle"}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block text-muted-foreground">Nom</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="prod, écriture, 2 approbateurs Ops" className="h-8" />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Connexions</span>
          <select value={kind} onChange={(e) => { setKind(e.target.value); setConnectionId(""); }} className={inputCls}>
            <option value="">Toutes</option>
            <option value="mcp">Serveurs MCP</option>
            <option value="custom_connector">Outils internes</option>
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Connexion précise</span>
          <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} disabled={!kind} className={inputCls}>
            <option value="">{kind ? "Toutes celles de ce type" : "Choisissez d'abord un type"}</option>
            {choices.map((c) => <option key={c.id} value={c.id}>{c.name}{c.environment ? ` (${ENV_LABEL[c.environment] ?? c.environment})` : ""}</option>)}
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Environnement de la connexion</span>
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)} className={inputCls}>
            <option value="">Tous</option>
            <option value="production">Production</option>
            <option value="staging">Recette</option>
            <option value="development">Développement</option>
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">À partir de</span>
          <select value={minRisk} onChange={(e) => setMinRisk(e.target.value as "write" | "destructive")} className={inputCls}>
            <option value="write">Toute écriture</option>
            <option value="destructive">Actions irréversibles seulement</option>
          </select>
        </label>
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block text-muted-foreground">Opérations (tools MCP ou opérations d'un outil interne ; vide : toutes)</span>
          <Input value={operations} onChange={(e) => setOperations(e.target.value)} placeholder="deployment_restart, alert_silence_create" className="h-8 font-mono" />
        </label>
        <div className="text-xs sm:col-span-2">
          <span className="mb-1 block text-muted-foreground">Approbateurs : un rôle FounderOS…</span>
          <div className="flex flex-wrap gap-3">
            {(["owner", "admin", "member"] as const).map((r) => (
              <label key={r} className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles((rs) => e.target.checked ? [...rs, r] : rs.filter((x) => x !== r))} />
                {ROLE_LABEL[r]}
              </label>
            ))}
          </div>
        </div>
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block text-muted-foreground">… ou un rôle / groupe de l'IdP (séparés par des virgules)</span>
          <Input value={idpRoles} onChange={(e) => setIdpRoles(e.target.value)} placeholder="Ops, ai-ops-prd-approver" className="h-8" />
          <span className="mt-1 block text-[10px] text-muted-foreground">
            Lus dans le jeton de l'IdP (rôles, claim groups) et dans les groupes du SSO, relevés à chaque connexion.
          </span>
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Approbateurs distincts requis</span>
          <Input type="number" min={1} max={5} value={quorum} onChange={(e) => setQuorum(e.target.value)} className="h-8" />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Échéance (minutes)</span>
          <Input type="number" min={1} max={1440} value={ttl} onChange={(e) => setTtl(e.target.value)} className="h-8" />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Connexion SSO récente pour voter (minutes, facultatif)</span>
          <Input type="number" min={1} max={10080} value={freshLogin} onChange={(e) => setFreshLogin(e.target.value)} placeholder="ex. 60" className="h-8" />
          <span className="mt-1 block text-[10px] text-muted-foreground">Les groupes sont relus à la connexion : un départ dans l'IdP empêche alors de voter, même avec une session ouverte.</span>
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Priorité (la plus petite passe d'abord)</span>
          <Input type="number" min={0} max={1000} value={priority} onChange={(e) => setPriority(e.target.value)} className="h-8" />
        </label>
      </div>
      {issue && <p className="mt-2 text-[11px] text-destructive">{issue}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>Annuler</Button>
        <Button size="sm" onClick={save} disabled={saving || !!issue}>
          {saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Enregistrer
        </Button>
      </div>
    </div>
  );
}
