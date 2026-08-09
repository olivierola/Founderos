import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Lock, ShieldCheck, Users, ClipboardList, BadgeCheck, Check, X, Plus, Pencil, Trash2,
  Download, KeyRound, Search, SlidersHorizontal, ShieldAlert, Clock, FileCheck2,
} from "lucide-react";
import { ShieldStarIcon } from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Pill, Field, Select, FormDialog, type FieldDef } from "../ui";
import {
  useAuditEvents, useApprovals, useGovCrud, APPROVAL_KIND_META, RISK_TIER_META,
  type Approval,
} from "../shared";
import {
  COMPLIANCE_STATUS_META, AT_REST_LABELS, KEY_MGMT_LABELS, SECURITY_DEFAULTS,
  newComplianceFramework, newFtRole, nextKeyRotation, timeAgo,
  type ComplianceFramework, type EncryptionPolicy, type FtRole,
} from "./data";
import {
  useFtRolesDb, useServersDb, useFtVersionsDb, useFtEndpointsDb, useSecurityConfigDb,
  endpointApprovalTitle, type FtRoleRow,
} from "./db";

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onChange} disabled={disabled}
      className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-[hsl(var(--accent-teal))]" : "bg-muted", disabled && "cursor-not-allowed opacity-50")}
      aria-pressed={on}
    >
      <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", on ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

const CAPS: { key: keyof Omit<FtRole, "role" | "members">; label: string }[] = [
  { key: "canEditDatasets", label: "Modifier les datasets" },
  { key: "canTrain", label: "Lancer un entraînement" },
  { key: "canDeploy", label: "Déployer" },
  { key: "canDeleteModel", label: "Supprimer un modèle" },
];

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("fr-FR") : "—");
const isOverdue = (iso: string | null) => !!iso && new Date(iso).getTime() < Date.now();

function downloadFile(name: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export function GovFtSecurityPage() {
  // Politique de sécurité persistée (chiffrement + programme de conformité).
  const { config, loading: cfgLoading, save: saveConfig } = useSecurityConfigDb();
  // Audit réel — chaque action du studio (train, deploy, approve, toggle…) écrit
  // dans gov_audit_events.
  const { data: auditEvents, isLoading: auditLoading } = useAuditEvents();
  // RBAC persisté.
  const { roles, loading: rolesLoading, ready, flip, create: createRole, update: updateRole, remove: removeRole, seedDefaults } = useFtRolesDb();
  // File de validation réelle : déploiements prod + demandes de gouvernance.
  const { servers } = useServersDb();
  const { versions } = useFtVersionsDb(servers);
  const { endpoints, approve, reject } = useFtEndpointsDb(servers, versions);
  const { data: govApprovals } = useApprovals();
  const govCrud = useGovCrud("gov_approvals");

  const [policyOpen, setPolicyOpen] = useState(false);
  const [editingFw, setEditingFw] = useState<ComplianceFramework | null>(null);
  const [editingRole, setEditingRole] = useState<{ row: FtRoleRow | null; value: FtRole } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [auditQuery, setAuditQuery] = useState("");
  const [auditLimit, setAuditLimit] = useState(12);

  const pendingDeploys = useMemo(() => endpoints.filter((e) => e.status === "pending_approval"), [endpoints]);
  // Les demandes miroir d'un déploiement sont affichées via l'endpoint lui-même.
  const mirrored = useMemo(() => new Set(pendingDeploys.map(endpointApprovalTitle)), [pendingDeploys]);
  const pendingRequests = useMemo(
    () => (govApprovals ?? []).filter((a) => a.status === "pending" && !mirrored.has(a.title)),
    [govApprovals, mirrored],
  );
  const pendingCount = pendingDeploys.length + pendingRequests.length;

  const audit = useMemo(() => {
    const q = auditQuery.trim().toLowerCase();
    const all = auditEvents ?? [];
    if (!q) return all;
    return all.filter((e) => `${e.action} ${e.entity_label ?? ""} ${e.entity_type ?? ""} ${e.actor_name ?? ""}`.toLowerCase().includes(q));
  }, [auditEvents, auditQuery]);
  const auditLast30d = (auditEvents ?? []).filter((e) => Date.now() - new Date(e.created_at).getTime() < 30 * 86_400_000).length;

  const { encryption, compliance } = config;
  const conformes = compliance.filter((c) => c.status === "conforme").length;
  const rotationDue = nextKeyRotation(encryption);

  // ── Actions ────────────────────────────────────────────────────────────────
  const guard = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast.success(ok); return true; }
    catch (e) { toast.error(e instanceof Error ? e.message : "Action impossible"); return false; }
  };

  const savePolicy = (next: EncryptionPolicy) =>
    guard(() => saveConfig({ ...config, encryption: next }, "security.policy_updated", "politique de chiffrement"), "Politique de sécurité enregistrée");

  const rotateKeys = () =>
    guard(() => saveConfig(
      { ...config, encryption: { ...encryption, lastKeyRotationAt: new Date().toISOString() } },
      "security.keys_rotated", `chiffrement ${AT_REST_LABELS[encryption.atRest]}`,
    ), "Rotation des clés enregistrée");

  const saveFramework = (fw: ComplianceFramework) => {
    const exists = compliance.some((c) => c.id === fw.id);
    const next = exists ? compliance.map((c) => (c.id === fw.id ? fw : c)) : [...compliance, fw];
    return guard(() => saveConfig({ ...config, compliance: next }, exists ? "compliance.updated" : "compliance.added", fw.name), "Référentiel enregistré");
  };
  const removeFramework = (fw: ComplianceFramework) => {
    if (!confirm(`Retirer « ${fw.name} » du programme de conformité ?`)) return;
    void guard(() => saveConfig({ ...config, compliance: compliance.filter((c) => c.id !== fw.id) }, "compliance.removed", fw.name), "Référentiel retiré");
  };

  const submitRole = async (value: FtRole, row: FtRoleRow | null) => {
    if (row) await updateRole(row.id, value);
    else await createRole(value);
  };
  const deleteRole = (r: FtRoleRow) => {
    if (!confirm(`Supprimer le rôle « ${r.role} » ?`)) return;
    void guard(() => removeRole(r), "Rôle supprimé");
  };

  const decideDeploy = (e: (typeof pendingDeploys)[number], approved: boolean) => {
    const note = approved ? null : (prompt("Motif du rejet (optionnel) :") ?? "");
    void guard(() => (approved ? approve(e, note) : reject(e, note || null)),
      approved ? "Déploiement approuvé" : "Déploiement rejeté");
  };
  const decideRequest = (a: Approval, status: "approved" | "rejected" | "changes_requested") => {
    const note = status === "approved" ? "" : (prompt("Motif de la décision (optionnel) :") ?? "");
    void guard(() => govCrud.update(a.id, {
      status, decided_by: govCrud.userId, decided_at: new Date().toISOString(), decision_note: note || null,
    }, { action: `approval.${status}`, entityType: "approval", entityId: a.id, entityLabel: a.title }),
      status === "approved" ? "Demande approuvée" : status === "rejected" ? "Demande rejetée" : "Modifications demandées");
  };

  const exportAudit = () => {
    const head = ["Date", "Action", "Type", "Objet", "Acteur"];
    const body = audit.map((e) => [new Date(e.created_at).toISOString(), e.action, e.entity_type ?? "", e.entity_label ?? "", e.actor_name ?? "système"]);
    downloadFile(`audit-${new Date().toISOString().slice(0, 10)}.csv`,
      [head, ...body].map((r) => r.map(csvCell).join(";")).join("\n"), "text/csv");
    toast.success(`${audit.length} événement(s) exporté(s)`);
  };

  const exportReport = () => {
    const L: string[] = [];
    L.push(`# Rapport de sécurité — ${new Date().toLocaleDateString("fr-FR")}`, "");
    L.push("## Chiffrement", "");
    L.push(`- Au repos : ${AT_REST_LABELS[encryption.atRest]} · ${KEY_MGMT_LABELS[encryption.keyManagement]}`);
    L.push(`- Rotation des clés : tous les ${encryption.keyRotationDays} jours — dernière ${fmtDate(encryption.lastKeyRotationAt)}`);
    L.push(`- En transit : TLS ${encryption.tlsMin} minimum`);
    L.push(`- Anonymisation des PII à l'ingestion : ${encryption.piiRedaction ? "activée" : "désactivée"}`);
    L.push(`- Validation humaine avant déploiement prod : ${encryption.requireProdApproval ? "exigée" : "non exigée"}`, "");
    L.push("## Conformité", "", "| Référentiel | Statut | Responsable | Dernier audit | Prochaine revue |", "| --- | --- | --- | --- | --- |");
    for (const c of compliance) L.push(`| ${c.name} | ${COMPLIANCE_STATUS_META[c.status].label} | ${c.owner || "—"} | ${fmtDate(c.lastAuditAt)} | ${fmtDate(c.nextReviewAt)} |`);
    L.push("", "## RBAC", "", `| Rôle | Membres | ${CAPS.map((c) => c.label).join(" | ")} |`, `| --- | --- | ${CAPS.map(() => "---").join(" | ")} |`);
    for (const r of roles) L.push(`| ${r.role} | ${r.members} | ${CAPS.map((c) => (r[c.key] ? "oui" : "non")).join(" | ")} |`);
    L.push("", `## Validations en attente (${pendingCount})`, "");
    for (const e of pendingDeploys) L.push(`- ${endpointApprovalTitle(e)} — surface ${e.surface}, traffic ${e.trafficPct}%`);
    for (const a of pendingRequests) L.push(`- ${a.title}${a.requested_by_name ? ` — demandé par ${a.requested_by_name}` : ""}`);
    if (pendingCount === 0) L.push("_Aucune._");
    L.push("", `## Audit — ${Math.min(50, audit.length)} derniers événements`, "");
    for (const e of audit.slice(0, 50)) L.push(`- ${new Date(e.created_at).toLocaleString("fr-FR")} · \`${e.action}\` · ${e.entity_label ?? e.entity_type ?? ""} · ${e.actor_name ?? "système"}`);
    downloadFile(`rapport-securite-${new Date().toISOString().slice(0, 10)}.md`, L.join("\n"), "text/markdown");
    toast.success("Rapport de conformité exporté");
  };

  const requestFields: FieldDef[] = [
    { key: "title", label: "Objet de la demande", required: true, placeholder: "Accès au dataset support-conversations" },
    { key: "kind", label: "Type", type: "select", options: APPROVAL_KIND_META, half: true },
    { key: "risk_tier", label: "Niveau de risque", type: "select", half: true,
      options: [{ value: "", label: "— Non défini —" }, ...Object.entries(RISK_TIER_META).map(([v, x]) => ({ value: v, label: x.label }))] },
    { key: "requested_by_name", label: "Demandeur" },
    { key: "description", label: "Contexte", type: "textarea" },
  ];

  if (cfgLoading && rolesLoading) return <PageSkeleton cards={4} rows={6} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Security"
        description="Chiffrement des datasets, RBAC, audit complet, validation avant déploiement et conformité RGPD / SOC 2 / ISO 27001."
        actions={
          <>
            <Button variant="outline" onClick={exportReport}><Download className="mr-1.5 h-4 w-4" />Rapport</Button>
            <Button onClick={() => setPolicyOpen(true)}><SlidersHorizontal className="mr-1.5 h-4 w-4" />Politique de sécurité</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Validations en attente" value={String(pendingCount)} icon={Clock} hint={encryption.requireProdApproval ? "prod sous approbation" : "⚠ prod sans approbation"} />
        <MetricCard label="Référentiels conformes" value={`${conformes}/${compliance.length}`} icon={FileCheck2} />
        <MetricCard label="Rôles" value={String(roles.length)} icon={Users} hint={`${roles.reduce((s, r) => s + r.members, 0)} membres couverts`} />
        <MetricCard label="Événements d'audit" value={String(auditLast30d)} icon={ClipboardList} hint="30 derniers jours" />
      </div>

      {/* Chiffrement + conformité */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Card className="flex flex-col p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Lock className="h-4 w-4 text-emerald-500" />Au repos
            <Pill meta={{ label: AT_REST_LABELS[encryption.atRest], tone: encryption.atRest === "none" ? "red" : "emerald" }} className="ml-auto px-1.5 py-0 text-[10px]" />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Datasets & poids — {KEY_MGMT_LABELS[encryption.keyManagement]}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Rotation tous les {encryption.keyRotationDays} j · dernière {fmtDate(encryption.lastKeyRotationAt)}
            {isOverdue(rotationDue) && <span className="ml-1 font-medium text-red-500">— échue</span>}
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void rotateKeys()}>
              <KeyRound className="mr-1.5 h-3.5 w-3.5" />Rotation
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPolicyOpen(true)}>Configurer</Button>
          </div>
        </Card>

        <Card className="flex flex-col p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Lock className="h-4 w-4 text-emerald-500" />En transit
            <Pill meta={{ label: `TLS ${encryption.tlsMin}`, tone: "emerald" }} className="ml-auto px-1.5 py-0 text-[10px]" />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Minimum imposé sur toutes les APIs et le serving</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Anonymisation des PII à l'ingestion : {encryption.piiRedaction ? "activée" : "désactivée"}
          </p>
          <div className="mt-3">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPolicyOpen(true)}>Configurer</Button>
          </div>
        </Card>

        {compliance.map((c) => (
          <Card key={c.id} className="group flex flex-col p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <BadgeCheck className={cn("h-4 w-4", c.status === "conforme" ? "text-emerald-500" : c.status === "non_conforme" ? "text-red-500" : "text-amber-500")} />
              <span className="truncate">{c.name}</span>
              <Pill meta={COMPLIANCE_STATUS_META[c.status]} className="ml-auto shrink-0 px-1.5 py-0 text-[10px]" />
            </div>
            {c.note && <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{c.note}</p>}
            <p className="mt-2 text-[11px] text-muted-foreground">
              {c.owner ? `${c.owner} · ` : ""}revue {fmtDate(c.nextReviewAt)}
              {isOverdue(c.nextReviewAt) && <span className="ml-1 font-medium text-red-500">— en retard</span>}
            </p>
            <div className="mt-auto flex items-center gap-1 pt-2">
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingFw(c)}><Pencil className="mr-1.5 h-3.5 w-3.5" />Éditer</Button>
              {c.evidenceUrl && <a href={c.evidenceUrl} target="_blank" rel="noreferrer" className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">preuves</a>}
              <Button size="icon" variant="ghost" className="ml-auto h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100" onClick={() => removeFramework(c)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </Card>
        ))}

        <Card className="flex items-center justify-center border-dashed p-4">
          <Button variant="ghost" className="h-auto flex-col gap-1 py-3 text-xs text-muted-foreground" onClick={() => setEditingFw(newComplianceFramework())}>
            <Plus className="h-4 w-4" />Ajouter un référentiel
          </Button>
        </Card>
      </div>

      {/* Approbations avant déploiement */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-3 text-sm font-medium">
          <ShieldStarIcon weight="duotone" className="h-4 w-4 text-muted-foreground" /> Validations en attente
          <span className="text-xs font-normal text-muted-foreground">
            — {encryption.requireProdApproval ? "tout déploiement en production requiert une approbation" : "l'approbation prod est désactivée dans la politique"}
          </span>
          <Button size="sm" variant="outline" className="ml-auto h-8" onClick={() => setRequesting(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />Demande
          </Button>
        </div>
        {pendingCount === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">
            Aucune validation en attente. Les déploiements en production et les demandes de gouvernance arrivent ici.
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {pendingDeploys.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{endpointApprovalTitle(e)}</div>
                  <div className="text-[11px] text-muted-foreground">Surface : {e.surface} · traffic {e.trafficPct}% · demandé {timeAgo(e.since)}</div>
                </div>
                <Button size="sm" className="h-8" onClick={() => decideDeploy(e, true)}><Check className="mr-1.5 h-3.5 w-3.5" />Approuver</Button>
                <Button size="sm" variant="outline" className="h-8" onClick={() => decideDeploy(e, false)}><X className="mr-1.5 h-3.5 w-3.5" />Rejeter</Button>
              </div>
            ))}
            {pendingRequests.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{a.title}</span>
                    <Pill meta={APPROVAL_KIND_META[a.kind]} className="px-1.5 py-0 text-[10px]" />
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {a.description ? `${a.description} · ` : ""}{a.requested_by_name ? `demandé par ${a.requested_by_name} · ` : ""}{timeAgo(a.created_at)}
                  </div>
                </div>
                <Button size="sm" className="h-8" onClick={() => decideRequest(a, "approved")}><Check className="mr-1.5 h-3.5 w-3.5" />Approuver</Button>
                <Button size="sm" variant="outline" className="h-8" onClick={() => decideRequest(a, "changes_requested")}>Modifs</Button>
                <Button size="sm" variant="ghost" className="h-8 text-red-600 dark:text-red-400" onClick={() => decideRequest(a, "rejected")}><X className="mr-1.5 h-3.5 w-3.5" />Rejeter</Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* RBAC */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-3 text-sm font-medium">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" /> RBAC — rôles & permissions
          <div className="ml-auto flex gap-2">
            {roles.length > 0 && (
              <Button size="sm" variant="ghost" className="h-8" onClick={() => void guard(seedDefaults, "Rôles standard ajoutés")}>Rôles standard</Button>
            )}
            <Button size="sm" variant="outline" className="h-8" disabled={!ready} onClick={() => setEditingRole({ row: null, value: newFtRole() })}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />Rôle
            </Button>
          </div>
        </div>
        {roles.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-secondary text-muted-foreground"><ShieldAlert className="h-5 w-5" /></div>
            <div>
              <div className="text-sm font-medium">Aucun rôle défini</div>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Définissez qui peut modifier les datasets, lancer un entraînement, déployer ou supprimer un modèle.
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={!ready} onClick={() => void guard(seedDefaults, "Matrice de rôles créée")}>Créer les rôles par défaut</Button>
              <Button size="sm" variant="outline" disabled={!ready} onClick={() => setEditingRole({ row: null, value: newFtRole() })}>Rôle personnalisé</Button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2.5 font-medium">Rôle</th>
                  <th className="px-4 py-2.5 font-medium">Membres</th>
                  {CAPS.map((c) => <th key={c.key} className="px-4 py-2.5 text-center font-medium">{c.label}</th>)}
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {roles.map((r) => (
                  <tr key={r.id} className="group">
                    <td className="px-5 py-3 font-medium">{r.role}</td>
                    <td className="px-4 py-3"><span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" />{r.members}</span></td>
                    {CAPS.map((c) => (
                      <td key={c.key} className="px-4 py-3 text-center">
                        <div className="flex justify-center">
                          <Toggle on={r[c.key]} onChange={() => void guard(() => flip(r, c.key), `${r.role} · ${c.label} ${r[c.key] ? "retiré" : "accordé"}`)} disabled={r.role === "Admin"} />
                        </div>
                      </td>
                    ))}
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingRole({ row: r, value: r })}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => deleteRole(r)}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-5 py-2.5 text-[11px] text-muted-foreground">Le rôle Admin conserve toutes les permissions ; il ne peut pas être restreint.</p>
          </div>
        )}
      </Card>

      {/* Audit trail */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-3 text-sm font-medium">
          <ClipboardList className="h-4 w-4 text-muted-foreground" /> Audit
          <span className="text-xs font-normal text-muted-foreground">— {audit.length} événement(s)</span>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={auditQuery} onChange={(e) => setAuditQuery(e.target.value)} placeholder="Filtrer (action, objet, acteur)" className="h-8 w-56 pl-8 text-xs" />
            </div>
            <Button size="sm" variant="outline" className="h-8" disabled={audit.length === 0} onClick={exportAudit}>
              <Download className="mr-1.5 h-3.5 w-3.5" />CSV
            </Button>
          </div>
        </div>
        {auditLoading ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">Chargement…</p>
        ) : audit.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">
            {auditQuery ? "Aucun événement ne correspond au filtre." : "Aucun événement — vos actions dans le studio apparaîtront ici."}
          </p>
        ) : (
          <>
            <div className="divide-y divide-border/60">
              {audit.slice(0, auditLimit).map((e) => (
                <div key={e.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                  <code className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[11px]">{e.action}</code>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{e.entity_label ?? e.entity_type ?? ""}</span>
                  <span className="shrink-0 text-xs">{e.actor_name ?? "système"}</span>
                  <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">{timeAgo(e.created_at)}</span>
                </div>
              ))}
            </div>
            {audit.length > auditLimit && (
              <button onClick={() => setAuditLimit((n) => n + 25)} className="w-full border-t border-border/60 px-5 py-2.5 text-xs text-muted-foreground hover:bg-muted/30">
                Afficher plus ({audit.length - auditLimit} restants)
              </button>
            )}
          </>
        )}
      </Card>

      {policyOpen && <PolicyDialog initial={encryption} onClose={() => setPolicyOpen(false)} onSave={async (p) => { if (await savePolicy(p)) setPolicyOpen(false); }} />}

      {editingFw && (
        <FormDialog
          title={compliance.some((c) => c.id === editingFw.id) ? "Éditer le référentiel" : "Nouveau référentiel"}
          fields={[
            { key: "name", label: "Référentiel", required: true, placeholder: "RGPD, SOC 2 Type II, ISO 27001, EU AI Act…" },
            { key: "status", label: "Statut", type: "select", options: COMPLIANCE_STATUS_META, half: true },
            { key: "owner", label: "Responsable", half: true, placeholder: "DPO, RSSI…" },
            { key: "lastAuditAt", label: "Dernier audit", type: "date", half: true },
            { key: "nextReviewAt", label: "Prochaine revue", type: "date", half: true },
            { key: "evidenceUrl", label: "Lien vers les preuves", placeholder: "https://…" },
            { key: "note", label: "Note", type: "textarea" },
          ]}
          initial={{
            name: editingFw.name, status: editingFw.status, owner: editingFw.owner,
            lastAuditAt: editingFw.lastAuditAt?.slice(0, 10) ?? "", nextReviewAt: editingFw.nextReviewAt?.slice(0, 10) ?? "",
            evidenceUrl: editingFw.evidenceUrl, note: editingFw.note,
          }}
          onClose={() => setEditingFw(null)}
          onSubmit={async (v) => {
            await saveFramework({
              ...editingFw,
              name: String(v.name ?? "").trim(), status: (v.status as ComplianceFramework["status"]) ?? "en_cours",
              owner: String(v.owner ?? ""), note: String(v.note ?? ""), evidenceUrl: String(v.evidenceUrl ?? ""),
              lastAuditAt: (v.lastAuditAt as string) || null, nextReviewAt: (v.nextReviewAt as string) || null,
            });
          }}
        />
      )}

      {editingRole && (
        <RoleDialog
          initial={editingRole.value}
          isNew={!editingRole.row}
          onClose={() => setEditingRole(null)}
          onSave={async (value) => { await submitRole(value, editingRole.row); setEditingRole(null); toast.success(editingRole.row ? "Rôle mis à jour" : "Rôle créé"); }}
        />
      )}

      {requesting && (
        <FormDialog
          title="Nouvelle demande de validation"
          fields={requestFields}
          initial={{ title: "", kind: "deployment", risk_tier: "", requested_by_name: govCrud.actorName ?? "", description: "" }}
          submitLabel="Soumettre"
          onClose={() => setRequesting(false)}
          onSubmit={async (v) => {
            await govCrud.create({ ...v, risk_tier: v.risk_tier || null, status: "pending" },
              { action: "approval.requested", entityType: "approval", entityLabel: String(v.title) });
            toast.success("Demande soumise");
          }}
        />
      )}
    </div>
  );
}

// ── Politique de chiffrement & contrôles ───────────────────────────────────────
function PolicyDialog({ initial, onClose, onSave }: { initial: EncryptionPolicy; onClose: () => void; onSave: (p: EncryptionPolicy) => Promise<void> | void }) {
  const [p, setP] = useState<EncryptionPolicy>(initial);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof EncryptionPolicy>(k: K, v: EncryptionPolicy[K]) => setP((prev) => ({ ...prev, [k]: v }));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>Politique de sécurité</DialogTitle></DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Chiffrement au repos">
            <Select value={p.atRest} onChange={(e) => set("atRest", e.target.value as EncryptionPolicy["atRest"])}>
              {Object.entries(AT_REST_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Gestion des clés">
            <Select value={p.keyManagement} onChange={(e) => set("keyManagement", e.target.value as EncryptionPolicy["keyManagement"])}>
              {Object.entries(KEY_MGMT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Rotation des clés (jours)">
            <Input type="number" min={0} value={p.keyRotationDays} onChange={(e) => set("keyRotationDays", Number(e.target.value) || 0)} />
          </Field>
          <Field label="TLS minimum">
            <Select value={p.tlsMin} onChange={(e) => set("tlsMin", e.target.value as EncryptionPolicy["tlsMin"])}>
              <option value="1.3">TLS 1.3</option>
              <option value="1.2">TLS 1.2</option>
            </Select>
          </Field>
        </div>

        <div className="mt-2 space-y-3 rounded-md border border-border/60 p-3">
          <label className="flex items-start gap-3">
            <Toggle on={p.piiRedaction} onChange={() => set("piiRedaction", !p.piiRedaction)} />
            <span className="text-sm">
              Anonymiser les PII à l'ingestion
              <span className="block text-[11px] text-muted-foreground">Ajoute la suppression des emails, des données sensibles et l'anonymisation au pipeline de préparation des datasets importés.</span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <Toggle on={p.requireProdApproval} onChange={() => set("requireProdApproval", !p.requireProdApproval)} />
            <span className="text-sm">
              Exiger une validation humaine avant la production
              <span className="block text-[11px] text-muted-foreground">Un déploiement en prod part en attente dans cette page et crée une demande dans le registre de gouvernance.</span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setP(SECURITY_DEFAULTS.encryption)}>Valeurs par défaut</Button>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button disabled={saving} onClick={async () => { setSaving(true); try { await onSave(p); } finally { setSaving(false); } }}>
            {saving ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Rôle RBAC ────────────────────────────────────────────────────────────────
function RoleDialog({ initial, isNew, onClose, onSave }: { initial: FtRole; isNew: boolean; onClose: () => void; onSave: (r: FtRole) => Promise<void> }) {
  const [r, setR] = useState<FtRole>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FtRole>(k: K, v: FtRole[K]) => setR((prev) => ({ ...prev, [k]: v }));

  const submit = async () => {
    setSaving(true); setError(null);
    try { await onSave({ ...r, role: r.role.trim() }); }
    catch (e) { setError(e instanceof Error ? e.message.includes("duplicate") ? "Un rôle porte déjà ce nom." : e.message : "Enregistrement impossible"); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{isNew ? "Nouveau rôle" : `Éditer « ${initial.role} »`}</DialogTitle></DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Nom du rôle" className="col-span-1">
            <Input value={r.role} onChange={(e) => set("role", e.target.value)} placeholder="Data Scientist" />
          </Field>
          <Field label="Membres" className="col-span-1">
            <Input type="number" min={0} value={r.members} onChange={(e) => set("members", Number(e.target.value) || 0)} />
          </Field>
        </div>

        <div className="mt-1 space-y-2 rounded-md border border-border/60 p-3">
          <span className="text-xs font-medium text-muted-foreground">Permissions</span>
          {CAPS.map((c) => (
            <label key={c.key} className="flex items-center gap-3 text-sm">
              <Toggle on={r[c.key]} onChange={() => set(c.key, !r[c.key])} />
              {c.label}
            </label>
          ))}
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button disabled={saving || !r.role.trim()} onClick={() => void submit()}>{saving ? "Enregistrement…" : "Enregistrer"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
