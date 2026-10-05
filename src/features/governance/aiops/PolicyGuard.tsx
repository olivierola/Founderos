import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ShieldCheckeredIcon as Shield,
  CircleNotchIcon as Loader2,
  ArrowClockwiseIcon as Refresh,
  CheckIcon as Check,
  XIcon as X,
  EyeIcon as Eye,
  ClockIcon as Clock,
  ProhibitIcon as Prohibit,
  PlusIcon as Plus,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { StatTile, compact } from "./StatTile";

// PolicyGuard — ce qu'un agent a le droit de faire seul, par équipe et par
// environnement, et la trace de chaque décision.
//
// Trois blocs, dans l'ordre où on s'en sert :
//   1. la GRILLE : par équipe, à partir de quel niveau de risque on demande une
//      approbation, on refuse, et jusqu'où l'autopilote dispense
//   2. la BIBLIOTHÈQUE : des règles de sortie prêtes à activer (engagements,
//      données personnelles, secrets…), installées comme des garde-fous jugés
//   3. le JOURNAL : chaque action évaluée, la décision, et la validation humaine
//
// Le runtime (_shared/policyguard.ts) garde une copie de la grille par défaut ;
// celle-ci n'est qu'un affichage. L'usage s'allume dans Jugement rapide.

type Level = 0 | 1 | 2 | 3;
interface EnvPolicy { approve_at: Level | null; block_at: Level | null }
interface TeamPolicy { interactive: EnvPolicy; autonomous: EnvPolicy; autopilot_ceiling: Level | 4 }

const DEFAULT_POLICY: TeamPolicy = {
  interactive: { approve_at: 2, block_at: null },
  autonomous: { approve_at: 2, block_at: null },
  autopilot_ceiling: 3,
};

const LEVELS: Array<{ value: Level; label: string; hint: string }> = [
  { value: 0, label: "0 · Lecture", hint: "consulter, chercher, lister" },
  { value: 1, label: "1 · Écriture interne", hint: "brouillon, étiquette, champ interne" },
  { value: 2, label: "2 · Visible par un tiers", hint: "e-mail, message, publication, invitation" },
  { value: 3, label: "3 · Irréversible", hint: "paiement, suppression, accès, engagement" },
];

const LEVEL_SHORT: Record<number, string> = { 0: "lecture", 1: "écriture interne", 2: "visible par un tiers", 3: "irréversible" };

function normalize(raw: unknown): TeamPolicy {
  const r = (raw ?? {}) as Partial<TeamPolicy>;
  const lvl = (v: unknown, fb: Level | null): Level | null =>
    v === null ? null : [0, 1, 2, 3].includes(Number(v)) ? (Number(v) as Level) : fb;
  const env = (e: unknown, d: EnvPolicy): EnvPolicy => {
    const x = (e ?? {}) as Partial<EnvPolicy>;
    return { approve_at: lvl(x.approve_at, d.approve_at), block_at: lvl(x.block_at, d.block_at) };
  };
  const c = Number(r.autopilot_ceiling);
  return {
    interactive: env(r.interactive, DEFAULT_POLICY.interactive),
    autonomous: env(r.autonomous, DEFAULT_POLICY.autonomous),
    autopilot_ceiling: [0, 1, 2, 3, 4].includes(c) ? (c as Level | 4) : DEFAULT_POLICY.autopilot_ceiling,
  };
}

/** Les règles prêtes à activer. Chacune devient un garde-fou jugé par le sens
 *  (le texte est ce que Jev lit : il décrit la faute, pas une consigne). */
const POLICY_PACK: Array<{ key: string; title: string; category: string; enforcement: "block" | "warn"; body: string }> = [
  {
    key: "commitments", title: "Aucun engagement commercial sans validation", category: "Engagements", enforcement: "block",
    body: "Le message promet ou accorde quelque chose au nom de l'entreprise : un prix ou une remise non publics, un délai de livraison, de remboursement ou d'intervention garanti, un geste commercial, une dérogation aux conditions générales.",
  },
  {
    key: "third_party_pii", title: "Pas de données personnelles de tiers", category: "Données personnelles", enforcement: "block",
    body: "Le message contient des données personnelles d'une personne qui n'est pas son destinataire : adresse e-mail, numéro de téléphone, adresse postale, IBAN, numéro de sécurité sociale, date de naissance, ou le contenu d'un échange avec une autre personne.",
  },
  {
    key: "secrets", title: "Pas de secrets ni d'identifiants", category: "Sécurité", enforcement: "block",
    body: "Le message contient un secret technique : clé d'API, mot de passe, jeton d'accès, clé privée, URL signée ou identifiants de connexion, même partiellement masqués.",
  },
  {
    key: "confidential", title: "Pas d'information interne confidentielle", category: "Confidentialité", enforcement: "warn",
    body: "Le message révèle une information interne non publique : chiffres financiers non publiés, feuille de route produit, noms ou contrats d'autres clients, salaires, incidents internes, négociations en cours.",
  },
  {
    key: "advice", title: "Pas de conseil juridique, médical ou financier personnalisé", category: "Conformité", enforcement: "warn",
    body: "Le message donne un avis personnalisé qui relève d'un professionnel réglementé : diagnostic ou traitement médical, conseil juridique sur la situation précise de la personne, recommandation d'investissement.",
  },
  {
    key: "tone", title: "Ton professionnel", category: "Qualité", enforcement: "warn",
    body: "Le message est insultant, sarcastique, méprisant, culpabilise le destinataire ou se moque de sa demande.",
  },
];

interface Decision {
  id: number; agent_id: string | null; service_dashboard_id: string | null;
  environment: "interactive" | "autonomous"; autopilot: boolean;
  tool: string; action: string; risk_level: number;
  decision: string; applied_decision: string; legacy_decision: string;
  policy_source: string; reason: string | null; mode: "shadow" | "on";
  approval_id: string | null; created_at: string;
}
interface Approval { id: string; status: string; decided_at: string | null; decided_by: string | null }

const when = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function GovPolicyGuardPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["policyguard", workspaceId, projectId],
    enabled: !!workspaceId && !!projectId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();
      const [teams, policies, decisions, agents, guardrails] = await Promise.all([
        supabase.from("service_dashboards").select("id, name").eq("project_id", projectId!).order("position"),
        supabase.from("policyguard_policies").select("id, service_dashboard_id, policy").eq("project_id", projectId!),
        supabase.from("policy_decisions")
          .select("id, agent_id, service_dashboard_id, environment, autopilot, tool, action, risk_level, decision, applied_decision, legacy_decision, policy_source, reason, mode, approval_id, created_at")
          .eq("project_id", projectId!).gte("created_at", since)
          .order("created_at", { ascending: false }).limit(2000),
        supabase.from("internal_agents").select("id, name").eq("workspace_id", workspaceId!),
        supabase.from("aiops_guardrails").select("id, title, enabled").eq("project_id", projectId!),
      ]);
      const rows = (decisions.data ?? []) as Decision[];
      const approvalIds = [...new Set(rows.map((r) => r.approval_id).filter((x): x is string => !!x))];
      const approvals = new Map<string, Approval>();
      if (approvalIds.length) {
        const { data: aps } = await supabase.from("internal_agent_approvals")
          .select("id, status, decided_at, decided_by").in("id", approvalIds.slice(0, 500));
        for (const a of (aps ?? []) as Approval[]) approvals.set(a.id, a);
      }
      return {
        teams: (teams.data ?? []) as Array<{ id: string; name: string }>,
        policies: (policies.data ?? []) as Array<{ id: string; service_dashboard_id: string | null; policy: unknown }>,
        decisions: rows,
        approvals,
        agentNames: new Map(((agents.data ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name])),
        guardrailTitles: new Set(((guardrails.data ?? []) as Array<{ title: string }>).map((g) => g.title)),
      };
    },
  });

  const decisions = data?.decisions ?? [];
  const kpis = useMemo(() => {
    const approvals = [...(data?.approvals.values() ?? [])];
    const decided = approvals.filter((a) => a.status !== "pending");
    const accepted = decided.filter((a) => a.status === "approved" || a.status === "executed" || a.status === "failed");
    return {
      evaluated: decisions.length,
      approvals: decisions.filter((d) => d.applied_decision === "approve").length,
      blocked: decisions.filter((d) => d.applied_decision === "block").length,
      stricter: decisions.filter((d) => d.decision !== d.legacy_decision && d.decision !== "allow").length,
      acceptRate: decided.length ? accepted.length / decided.length : null,
      pending: approvals.filter((a) => a.status === "pending").length,
    };
  }, [decisions, data?.approvals]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="PolicyGuard"
        description="Ce que vos agents ont le droit de faire seuls, équipe par équipe : chaque action d'écriture reçoit un niveau de risque, confronté à la grille de son équipe. Une approbation demandée par l'ancienne règle n'est jamais retirée."
        actions={
          <Button variant="outline" size="sm" className="gap-1.5"
            onClick={() => qc.invalidateQueries({ queryKey: ["policyguard", workspaceId, projectId] })}>
            <Refresh className="h-3.5 w-3.5" /> Rafraîchir
          </Button>
        }
      />

      {isLoading || !data ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile label="Actions évaluées" value={compact(kpis.evaluated)} hint="30 derniers jours" />
            <StatTile label="Approbations demandées" value={compact(kpis.approvals)} hint="décision appliquée" />
            <StatTile label="Actions refusées" value={compact(kpis.blocked)} hint="par la grille" />
            <StatTile label="Plus strict qu'avant" value={compact(kpis.stricter)} hint="que l'ancienne règle aurait laissé passer" />
            <StatTile label="Validations acceptées" value={kpis.acceptRate == null ? "—" : `${Math.round(kpis.acceptRate * 100)} %`} hint="des approbations tranchées" />
            <StatTile label="En attente" value={compact(kpis.pending)} alert={kpis.pending > 0 ? "à valider" : null} hint="rien en attente" />
          </div>

          <PolicyGrid teams={data.teams} policies={data.policies} workspaceId={workspaceId!} projectId={projectId!}
            onSaved={() => qc.invalidateQueries({ queryKey: ["policyguard", workspaceId, projectId] })} />

          <PolicyLibrary teams={data.teams} installed={data.guardrailTitles} workspaceId={workspaceId!} projectId={projectId!}
            onInstalled={() => qc.invalidateQueries({ queryKey: ["policyguard", workspaceId, projectId] })} />

          <AuditLog decisions={decisions} approvals={data.approvals} agentNames={data.agentNames} teams={data.teams} />
        </>
      )}
    </div>
  );
}

// ── La grille ────────────────────────────────────────────────────────────────

function LevelSelect({ value, onChange, allowNever, neverLabel = "jamais" }: {
  value: number | null; onChange: (v: number | null) => void; allowNever?: boolean; neverLabel?: string;
}) {
  return (
    <select
      value={value == null ? "never" : String(value)}
      onChange={(e) => onChange(e.target.value === "never" ? null : Number(e.target.value))}
      className="h-8 rounded-md border border-input bg-background px-2 text-[12px]"
    >
      {LEVELS.map((l) => <option key={l.value} value={l.value}>dès {l.label}</option>)}
      {allowNever && <option value="never">{neverLabel}</option>}
    </select>
  );
}

function PolicyGrid({ teams, policies, workspaceId, projectId, onSaved }: {
  teams: Array<{ id: string; name: string }>;
  policies: Array<{ id: string; service_dashboard_id: string | null; policy: unknown }>;
  workspaceId: string; projectId: string; onSaved: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, TeamPolicy>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const projectRow = policies.find((p) => p.service_dashboard_id === null);
  const projectPolicy = projectRow ? normalize(projectRow.policy) : DEFAULT_POLICY;
  const rows: Array<{ key: string; teamId: string | null; label: string; own: boolean; policy: TeamPolicy }> = [
    { key: "project", teamId: null, label: "Projet, par défaut", own: !!projectRow, policy: projectPolicy },
    ...teams.map((t) => {
      const own = policies.find((p) => p.service_dashboard_id === t.id);
      return { key: t.id, teamId: t.id, label: t.name, own: !!own, policy: own ? normalize(own.policy) : projectPolicy };
    }),
  ];

  const current = (key: string, fallback: TeamPolicy) => drafts[key] ?? fallback;
  const patch = (key: string, base: TeamPolicy, fn: (p: TeamPolicy) => TeamPolicy) =>
    setDrafts((d) => ({ ...d, [key]: fn(structuredClone(d[key] ?? base)) }));

  async function save(row: typeof rows[number]) {
    const policy = current(row.key, row.policy);
    setSaving(row.key);
    try {
      const existing = policies.find((p) => p.service_dashboard_id === row.teamId);
      const { data: auth } = await supabase.auth.getUser();
      const values = { policy, updated_by: auth.user?.id ?? null, updated_at: new Date().toISOString() };
      const { error } = existing
        ? await supabase.from("policyguard_policies").update(values).eq("id", existing.id)
        : await supabase.from("policyguard_policies").insert({
            workspace_id: workspaceId, project_id: projectId, service_dashboard_id: row.teamId, ...values,
          });
      if (error) throw error;
      setDrafts((d) => { const n = { ...d }; delete n[row.key]; return n; });
      toast.success(`Politique « ${row.label} » enregistrée`);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Enregistrement impossible (réservé aux administrateurs)");
    } finally {
      setSaving(null);
    }
  }

  async function reset(row: typeof rows[number]) {
    const existing = policies.find((p) => p.service_dashboard_id === row.teamId);
    if (!existing) return;
    setSaving(row.key);
    const { error } = await supabase.from("policyguard_policies").delete().eq("id", existing.id);
    setSaving(null);
    if (error) { toast.error(error.message); return; }
    setDrafts((d) => { const n = { ...d }; delete n[row.key]; return n; });
    onSaved();
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="border-b border-border/60 px-4 py-2.5">
          <div className="text-[13px] font-medium">Grille par équipe</div>
          <div className="text-[11.5px] text-muted-foreground">
            <strong className="text-foreground">Interactif</strong> : quelqu'un est dans la conversation.{" "}
            <strong className="text-foreground">Autonome</strong> : mission, planification ou room, personne ne regarde au moment où l'action part.
            Le <strong className="text-foreground">plafond de l'autopilote</strong> est le niveau à partir duquel même un agent en autopilote demande.
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-border/40 text-left text-[11px] text-muted-foreground">
                <th className="px-4 py-2 font-normal">Équipe</th>
                <th className="px-2 py-2 font-normal">Interactif · approbation</th>
                <th className="px-2 py-2 font-normal">Interactif · refus</th>
                <th className="px-2 py-2 font-normal">Autonome · approbation</th>
                <th className="px-2 py-2 font-normal">Autonome · refus</th>
                <th className="px-2 py-2 font-normal">Plafond autopilote</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {rows.map((row) => {
                const p = current(row.key, row.policy);
                const dirty = !!drafts[row.key];
                return (
                  <tr key={row.key}>
                    <td className="px-4 py-2">
                      <div className="font-medium">{row.label}</div>
                      <div className="text-[10.5px] text-muted-foreground">
                        {row.own ? "politique propre" : row.teamId ? "hérite du projet" : "grille par défaut"}
                      </div>
                    </td>
                    <td className="px-2 py-2"><LevelSelect value={p.interactive.approve_at} allowNever
                      onChange={(v) => patch(row.key, row.policy, (x) => ({ ...x, interactive: { ...x.interactive, approve_at: v as Level | null } }))} /></td>
                    <td className="px-2 py-2"><LevelSelect value={p.interactive.block_at} allowNever
                      onChange={(v) => patch(row.key, row.policy, (x) => ({ ...x, interactive: { ...x.interactive, block_at: v as Level | null } }))} /></td>
                    <td className="px-2 py-2"><LevelSelect value={p.autonomous.approve_at} allowNever
                      onChange={(v) => patch(row.key, row.policy, (x) => ({ ...x, autonomous: { ...x.autonomous, approve_at: v as Level | null } }))} /></td>
                    <td className="px-2 py-2"><LevelSelect value={p.autonomous.block_at} allowNever
                      onChange={(v) => patch(row.key, row.policy, (x) => ({ ...x, autonomous: { ...x.autonomous, block_at: v as Level | null } }))} /></td>
                    <td className="px-2 py-2"><LevelSelect value={p.autopilot_ceiling === 4 ? null : p.autopilot_ceiling} allowNever neverLabel="aucun (tout passe)"
                      onChange={(v) => patch(row.key, row.policy, (x) => ({ ...x, autopilot_ceiling: (v == null ? 4 : v) as Level | 4 }))} /></td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      {row.own && row.teamId && !dirty && (
                        <Button variant="ghost" size="sm" className="h-7 text-[11.5px]" disabled={saving === row.key} onClick={() => reset(row)}>
                          Hériter du projet
                        </Button>
                      )}
                      {dirty && (
                        <Button size="sm" className="h-7 text-[11.5px]" disabled={saving === row.key} onClick={() => save(row)}>
                          {saving === row.key && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Enregistrer
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border/40 px-4 py-2.5 text-[11px] text-muted-foreground">
          {LEVELS.map((l) => <span key={l.value}><strong className="text-foreground">{l.label}</strong> — {l.hint}</span>)}
        </div>
      </CardContent>
    </Card>
  );
}

// ── La bibliothèque ──────────────────────────────────────────────────────────

function PolicyLibrary({ teams, installed, workspaceId, projectId, onInstalled }: {
  teams: Array<{ id: string; name: string }>; installed: Set<string>;
  workspaceId: string; projectId: string; onInstalled: () => void;
}) {
  const [team, setTeam] = useState<string>("");
  const [surface, setSurface] = useState<"both" | "internal" | "public">("both");
  const [busy, setBusy] = useState<string | null>(null);

  async function install(item: typeof POLICY_PACK[number]) {
    setBusy(item.key);
    try {
      // Ce sont des règles de SORTIE : pour un agent interne, le contenu part
      // dans les arguments d'un outil (tool_call) ; pour un agent public, c'est
      // sa réponse (tool_result). Jamais « all », qui jugerait aussi le message
      // reçu — et bloquerait un client parce qu'il a donné son propre e-mail.
      const surfaces: Array<"internal" | "public"> = surface === "both" ? ["internal", "public"] : [surface];
      const rows = surfaces.map((s) => ({
        workspace_id: workspaceId, project_id: projectId,
        title: surfaces.length > 1 ? `${item.title} (${s === "internal" ? "agents internes" : "agents publics"})` : item.title,
        category: item.category, enforcement: item.enforcement, enabled: true, body: item.body,
        match_scope: s === "internal" ? "tool_call" : "tool_result",
        team_ids: team ? [team] : [], surfaces: [s],
      }));
      const { error } = await supabase.from("aiops_guardrails").insert(rows);
      if (error) throw error;
      toast.success(`« ${item.title} » activée`);
      onInstalled();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Activation impossible");
    } finally {
      setBusy(null);
    }
  }

  const isInstalled = (title: string) =>
    installed.has(title) || installed.has(`${title} (agents internes)`) || installed.has(`${title} (agents publics)`);

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Vérification des sorties</div>
            <div className="text-[11.5px] text-muted-foreground">
              Des règles prêtes à activer, vérifiées sur ce que l'agent s'apprête à envoyer. Elles rejoignent vos Guardrails et sont jugées par le sens
              quand l'usage « Garde-fous sémantiques » est allumé.
            </div>
          </div>
          <select value={team} onChange={(e) => setTeam(e.target.value)} className="h-8 rounded-md border border-input bg-background px-2 text-[12px]">
            <option value="">Toutes les équipes</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select value={surface} onChange={(e) => setSurface(e.target.value as typeof surface)} className="h-8 rounded-md border border-input bg-background px-2 text-[12px]">
            <option value="both">Agents internes et publics</option>
            <option value="internal">Agents internes</option>
            <option value="public">Agents publics</option>
          </select>
        </div>
        <div className="grid gap-px bg-border/40 md:grid-cols-2">
          {POLICY_PACK.map((item) => {
            const done = isInstalled(item.title);
            return (
              <div key={item.key} className="flex gap-3 bg-card px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-medium">{item.title}</span>
                    <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
                      {item.enforcement === "block" ? <Prohibit className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      {item.enforcement === "block" ? "bloque" : "signale"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{item.body}</p>
                </div>
                <div className="shrink-0 self-center">
                  {done ? (
                    <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground"><Check className="h-3.5 w-3.5" /> Active</span>
                  ) : (
                    <Button size="sm" variant="outline" className="h-7 gap-1 text-[11.5px]" disabled={busy === item.key} onClick={() => install(item)}>
                      {busy === item.key ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />} Activer
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Le journal ───────────────────────────────────────────────────────────────

type DecisionFilter = "all" | "approve" | "block" | "stricter";

function AuditLog({ decisions, approvals, agentNames, teams }: {
  decisions: Decision[]; approvals: Map<string, Approval>;
  agentNames: Map<string, string>; teams: Array<{ id: string; name: string }>;
}) {
  const [filter, setFilter] = useState<DecisionFilter>("all");
  const teamName = (id: string | null) => (id && teams.find((t) => t.id === id)?.name) || "—";
  const rows = decisions.filter((d) =>
    filter === "all" ? true
    : filter === "stricter" ? d.decision !== d.legacy_decision && d.decision !== "allow"
    : d.applied_decision === filter);

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Journal d'audit</div>
            <div className="text-[11.5px] text-muted-foreground">Chaque action d'écriture évaluée, la règle appliquée et la validation humaine qui a suivi.</div>
          </div>
          <div className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
            {([["all", "Toutes"], ["approve", "Approbations"], ["block", "Refus"], ["stricter", "Plus strictes qu'avant"]] as Array<[DecisionFilter, string]>).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setFilter(k)}
                className={cn("rounded-md px-2.5 py-1.5 text-[11.5px] transition-colors",
                  filter === k ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="flex items-start gap-2 px-4 py-6 text-[12px] text-muted-foreground">
            <Shield className="mt-0.5 h-4 w-4 shrink-0" />
            {decisions.length === 0
              ? "Aucune action évaluée sur 30 jours. PolicyGuard s'allume dans Gouvernance IA → Jugement rapide (usage « PolicyGuard, risque des actions ») ; en Observation, chaque action est classée et journalisée ici sans rien changer."
              : "Aucune décision dans ce filtre."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-border/40 text-left text-[11px] text-muted-foreground">
                  <th className="px-4 py-2 font-normal">Quand</th>
                  <th className="px-2 py-2 font-normal">Agent · équipe</th>
                  <th className="px-2 py-2 font-normal">Action</th>
                  <th className="px-2 py-2 font-normal">Risque</th>
                  <th className="px-2 py-2 font-normal">Décision</th>
                  <th className="px-4 py-2 font-normal">Validation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {rows.slice(0, 100).map((d) => {
                  const ap = d.approval_id ? approvals.get(d.approval_id) : null;
                  return (
                    <tr key={d.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{when(d.created_at)}</td>
                      <td className="px-2 py-2">
                        <div className="font-medium">{(d.agent_id && agentNames.get(d.agent_id)) || "agent"}</div>
                        <div className="text-[10.5px] text-muted-foreground">
                          {teamName(d.service_dashboard_id)} · {d.environment === "interactive" ? "interactif" : "autonome"}{d.autopilot ? " · autopilote" : ""}
                        </div>
                      </td>
                      <td className="max-w-[260px] px-2 py-2">
                        <div className="truncate font-mono text-[11px]" title={`${d.tool} · ${d.action}`}>{d.tool} · {d.action}</div>
                        {d.reason && <div className="text-[10.5px] text-muted-foreground">{d.reason}</div>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">{d.risk_level} · {LEVEL_SHORT[d.risk_level]}</td>
                      <td className="whitespace-nowrap px-2 py-2"><DecisionLabel d={d} /></td>
                      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground"><ValidationLabel ap={ap ?? null} decision={d.applied_decision} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DecisionLabel({ d }: { d: Decision }) {
  const label = (x: string) => (x === "block" ? "refusée" : x === "approve" ? "approbation" : "autorisée");
  const Icon = d.applied_decision === "block" ? Prohibit : d.applied_decision === "approve" ? Clock : Check;
  return (
    <span className="flex flex-col">
      <span className="flex items-center gap-1 font-medium"><Icon className="h-3 w-3" /> {label(d.applied_decision)}</span>
      {d.mode === "shadow" && d.decision !== d.applied_decision && (
        <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground"><Eye className="h-3 w-3" /> aurait été : {label(d.decision)}</span>
      )}
      {d.mode === "on" && d.decision !== d.legacy_decision && (
        <span className="text-[10.5px] text-muted-foreground">avant : {label(d.legacy_decision)}</span>
      )}
    </span>
  );
}

function ValidationLabel({ ap, decision }: { ap: Approval | null; decision: string }) {
  if (decision !== "approve") return <span>—</span>;
  if (!ap) return <span>non reliée</span>;
  if (ap.status === "pending") return <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> en attente</span>;
  if (ap.status === "rejected") return <span className="flex items-center gap-1"><X className="h-3 w-3" /> refusée{ap.decided_at ? ` le ${when(ap.decided_at)}` : ""}</span>;
  return (
    <span className="flex items-center gap-1">
      <Check className="h-3 w-3" /> {ap.status === "failed" ? "approuvée (échec d'exécution)" : "approuvée"}{ap.decided_at ? ` le ${when(ap.decided_at)}` : ""}
    </span>
  );
}
