import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ShieldWarningIcon as ShieldWarn,
  CircleNotchIcon as Loader2,
  ArrowClockwiseIcon as Refresh,
  CheckIcon as Check,
  XIcon as X,
  WarningIcon as Warning,
  CopyIcon as Copy,
  PlusIcon as Plus,
  TrashIcon as Trash,
  PlugIcon as Plug,
  EyeIcon as Eye,
  SirenIcon as Siren,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { StatTile, compact } from "./StatTile";
import { ALERT_STATUS_LABEL, CATEGORY_LABEL, PRIORITY_LABEL } from "@/features/internal-agents/sentinel/SocBoardView";

// SentinelFlow — le triage SOC.
//
// Les alertes arrivent de partout (webhooks d'outils de sécurité, interrogation
// de leurs API, nos propres signaux, les agents, les imports) et sont ramenées
// à un format commun par le runtime (_shared/sentinel.ts). Cet écran :
//   · Alertes      — la file triée, le détail, les décisions humaines
//   · Sources      — brancher un outil, voir s'il parle, tester sa correspondance
//   · Actifs       — ce qui compte (criticité) et ce qui est un environnement de test
//   · Règles       — suppressions (faux positifs PROUVÉS) et procédures
//   · Remédiations — ce que les agents proposent, qu'une personne valide
//
// Le triage Jev s'allume dans Jugement rapide (usage « SentinelFlow — triage
// des alertes »). Éteint, les alertes arrivent quand même, avec la gravité
// annoncée par l'éditeur, et les faux positifs prouvés restent détectés.

type Tab = "alerts" | "sources" | "assets" | "rules" | "remediations";

const ADMIN_FN = "automation-receiver?sentinel=admin";
const hookUrl = (token: string) => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/automation-receiver?sentinel=${token}`;
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

interface Preset { key: string; label: string; delivery: Array<"webhook" | "poll">; setup: string }
interface Source {
  id: string; name: string; kind: string; vendor: string; items_path: string | null;
  mapping: Record<string, string[]> | null; token_hint: string | null; poll: Record<string, string> | null;
  poll_interval_minutes: number; last_polled_at: string | null; last_error: string | null; last_seen_at: string | null; enabled: boolean;
}
interface Alert {
  id: string; source_id: string; title: string; description: string | null; severity: number | null; severity_raw: string | null;
  priority: number | null; category: string | null; category_raw: string | null; status: string;
  host: string | null; src_ip: string | null; dst_ip: string | null; user_name: string | null; rule_id: string | null; rule_name: string | null;
  mitre: string[]; fp_verified: string[]; fp_hint_p: number | null; escalate: boolean; playbook: string | null;
  occurrences: number; occurred_at: string; triage_mode: string | null; notes: Array<{ at: string; by: string; text: string }>;
  resolution: string | null; raw: unknown;
}

const SOURCE_COLS = "id, name, kind, vendor, items_path, mapping, token_hint, poll, poll_interval_minutes, last_polled_at, last_error, last_seen_at, enabled";
const OPEN = ["new", "untriaged", "triaged", "escalated", "investigating"];

export function GovSentinelFlowPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("alerts");

  const { data: presets } = useQuery({
    queryKey: ["sentinel_presets"],
    staleTime: 3600_000,
    queryFn: async () => {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/automation-receiver?sentinel=presets`, {
        headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
      });
      const j = await res.json().catch(() => ({}));
      return ((j as { presets?: Preset[] }).presets ?? []) as Preset[];
    },
  });

  const { data, isLoading } = useQuery({
    queryKey: ["sentinel", projectId],
    enabled: !!projectId,
    refetchInterval: 30_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString();
      const [sources, alerts, actions] = await Promise.all([
        supabase.from("sentinel_sources").select(SOURCE_COLS).eq("project_id", projectId!).order("created_at"),
        supabase.from("sentinel_alerts").select("*").eq("project_id", projectId!).gte("occurred_at", since)
          .order("occurred_at", { ascending: false }).limit(1000),
        supabase.from("sentinel_actions").select("id, alert_id, playbook, remediation, justification, status, decided_at, decision_note, created_at")
          .eq("project_id", projectId!).order("created_at", { ascending: false }).limit(200),
      ]);
      return {
        sources: (sources.data ?? []) as Source[],
        alerts: (alerts.data ?? []) as Alert[],
        actions: (actions.data ?? []) as Array<{ id: string; alert_id: string; playbook: string | null; remediation: string; justification: string | null; status: string; decided_at: string | null; decision_note: string | null; created_at: string }>,
      };
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["sentinel", projectId] });
  const alerts = data?.alerts ?? [];
  const kpis = useMemo(() => ({
    open: alerts.filter((a) => OPEN.includes(a.status)).length,
    escalated: alerts.filter((a) => a.status === "escalated").length,
    critical: alerts.filter((a) => a.priority === 3 && OPEN.includes(a.status)).length,
    fp: alerts.filter((a) => a.fp_verified?.length).length,
    pending: (data?.actions ?? []).filter((x) => x.status === "pending").length,
    sources: (data?.sources ?? []).filter((s) => s.enabled).length,
  }), [alerts, data]);

  async function triageNow() {
    try {
      const r = await callEdge<{ triaged: number }>(ADMIN_FN, { action: "triage_now", workspace_id: workspaceId, project_id: projectId });
      toast.success(`${r.triaged} alerte(s) triée(s)`);
      refresh();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Tri impossible"); }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="SentinelFlow"
        description="Le triage de vos alertes de sécurité, d'où qu'elles viennent : chaque alerte est ramenée à un format commun, classée, rapprochée de son actif, et un faux positif n'est retenu que sur un critère vérifiable. Aucune remédiation ne part sans validation humaine."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={triageNow}><Siren className="h-3.5 w-3.5" /> Trier maintenant</Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={refresh}><Refresh className="h-3.5 w-3.5" /> Rafraîchir</Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Alertes ouvertes" value={compact(kpis.open)} hint="7 derniers jours" />
        <StatTile label="Escaladées" value={compact(kpis.escalated)} alert={kpis.escalated > 0 ? "analyste requis" : null} hint="aucune escalade" />
        <StatTile label="Critiques ouvertes" value={compact(kpis.critical)} alert={kpis.critical > 0 ? "à traiter en premier" : null} hint="aucune" />
        <StatTile label="Faux positifs prouvés" value={compact(kpis.fp)} hint="critères vérifiables" />
        <StatTile label="Remédiations à valider" value={compact(kpis.pending)} alert={kpis.pending > 0 ? "en attente de vous" : null} hint="rien en attente" />
        <StatTile label="Sources actives" value={compact(kpis.sources)} hint="branchées" />
      </div>

      <div className="flex items-center gap-0.5 self-start rounded-lg bg-muted/60 p-0.5">
        {([["alerts", "Alertes"], ["sources", "Sources"], ["assets", "Actifs"], ["rules", "Règles & procédures"], ["remediations", "Remédiations"]] as Array<[Tab, string]>).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={cn("rounded-md px-3 py-1.5 text-[12px] transition-colors", tab === k ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            {label}
          </button>
        ))}
      </div>

      {isLoading || !data ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : tab === "alerts" ? (
        <AlertsTab alerts={alerts} sources={data.sources} actions={data.actions} onChange={refresh} onGoSources={() => setTab("sources")} />
      ) : tab === "sources" ? (
        <SourcesTab sources={data.sources} presets={presets ?? []} workspaceId={workspaceId!} projectId={projectId!} onChange={refresh} />
      ) : tab === "assets" ? (
        <AssetsTab workspaceId={workspaceId!} projectId={projectId!} />
      ) : tab === "rules" ? (
        <RulesTab workspaceId={workspaceId!} projectId={projectId!} />
      ) : (
        <RemediationsTab actions={data.actions} alerts={alerts} onChange={refresh} />
      )}
    </div>
  );
}

// ── Alertes ──────────────────────────────────────────────────────────────────

function PriorityMark({ p }: { p: number | null }) {
  const lvl = p ?? 0;
  return (
    <span className="flex w-[84px] shrink-0 items-center gap-1 text-[11px]">
      <span className="flex gap-px" aria-hidden>
        {[0, 1, 2].map((i) => <span key={i} className={cn("h-2.5 w-[3px] rounded-sm", i < lvl ? "bg-foreground/70" : "bg-foreground/15")} />)}
      </span>
      {p == null ? "—" : PRIORITY_LABEL[p]}
    </span>
  );
}

type AlertFilter = "open" | "escalated" | "closed" | "all";

function AlertsTab({ alerts, sources, actions, onChange, onGoSources }: {
  alerts: Alert[]; sources: Source[]; actions: Array<{ alert_id: string; status: string; remediation: string }>;
  onChange: () => void; onGoSources: () => void;
}) {
  const { user } = useAuth();
  const [filter, setFilter] = useState<AlertFilter>("open");
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const sourceName = (id: string) => sources.find((s) => s.id === id)?.name ?? "source";

  const rows = alerts
    .filter((a) => filter === "all" ? true : filter === "open" ? OPEN.includes(a.status) : filter === "escalated" ? a.status === "escalated" : a.status.startsWith("closed"))
    .sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1) || b.occurred_at.localeCompare(a.occurred_at));
  const sel = alerts.find((a) => a.id === openId) ?? null;

  async function setStatus(status: string, requireNote = false) {
    if (!sel) return;
    if (requireNote && note.trim().length < 20) { toast.error("Expliquez en une phrase ce qui rend l'activité légitime, et comment vous l'avez vérifié."); return; }
    setBusy(true);
    try {
      const upd: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
      if (status.startsWith("closed")) { upd.closed_at = new Date().toISOString(); upd.resolution = note.trim() || null; }
      if (note.trim()) upd.notes = [...(sel.notes ?? []), { at: new Date().toISOString(), by: user?.email ?? "membre", text: note.trim() }].slice(-50);
      const { error } = await supabase.from("sentinel_alerts").update(upd).eq("id", sel.id);
      if (error) throw error;
      setNote("");
      onChange();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Mise à jour impossible"); }
    finally { setBusy(false); }
  }

  if (alerts.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex items-start gap-3 p-5 text-[12.5px] leading-relaxed text-muted-foreground">
          <Plug className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Aucune alerte sur 7 jours. Branchez une première source (webhook d'un SIEM ou d'un EDR, interrogation d'API, ou nos propres signaux)
            dans <button type="button" className="font-medium text-foreground underline" onClick={onGoSources}>Sources</button>. Le triage s'allume dans
            Gouvernance IA → Jugement rapide (« SentinelFlow, triage des alertes »).
          </span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-0.5 self-start rounded-lg bg-muted/60 p-0.5">
        {([["open", "À traiter"], ["escalated", "Escaladées"], ["closed", "Closes"], ["all", "Toutes"]] as Array<[AlertFilter, string]>).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setFilter(k)}
            className={cn("rounded-md px-2.5 py-1 text-[11.5px]", filter === k ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}>{label}</button>
        ))}
      </div>
      <div className={cn("grid gap-4", sel && "lg:grid-cols-[minmax(0,1fr)_440px]")}>
        <Card>
          <CardContent className="p-0">
            {rows.length === 0 ? <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">Aucune alerte dans cette vue.</div> : (
              <div className="divide-y divide-border/40">
                {rows.slice(0, 300).map((a) => (
                  <button key={a.id} type="button" onClick={() => { setOpenId(a.id === openId ? null : a.id); setNote(""); }}
                    className={cn("block w-full px-4 py-2.5 text-left text-[12px] hover:bg-muted/40", a.id === openId && "bg-muted/50")}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <PriorityMark p={a.priority ?? a.severity} />
                      <span className="min-w-0 flex-1 truncate font-medium">{a.title}</span>
                      {a.escalate && <span className="flex items-center gap-1 text-[10.5px] font-medium"><Siren className="h-3 w-3" /> escalade</span>}
                      {a.fp_verified?.length > 0 && <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground"><Check className="h-3 w-3" /> faux positif prouvé</span>}
                      <span className="shrink-0 text-[11px] text-muted-foreground">{ALERT_STATUS_LABEL[a.status] ?? a.status} · {when(a.occurred_at)}</span>
                    </div>
                    <div className="mt-0.5 truncate pl-[96px] text-[11px] text-muted-foreground">
                      {[CATEGORY_LABEL[a.category ?? ""] ?? a.category ?? a.category_raw, a.host, a.src_ip, a.user_name, sourceName(a.source_id)].filter(Boolean).join(" · ")}
                      {a.occurrences > 1 ? ` · ×${a.occurrences}` : ""}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {sel && (
          <Card className="self-start lg:sticky lg:top-4">
            <CardContent className="space-y-3 p-4 text-[12px]">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold leading-snug">{sel.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11.5px] text-muted-foreground">
                    <PriorityMark p={sel.priority ?? sel.severity} />
                    <span>{CATEGORY_LABEL[sel.category ?? ""] ?? sel.category ?? "non triée"}</span>
                    <span>{ALERT_STATUS_LABEL[sel.status] ?? sel.status}</span>
                    {sel.triage_mode === "shadow" && <span className="flex items-center gap-1"><Eye className="h-3 w-3" /> tri en observation</span>}
                  </div>
                </div>
                <button type="button" aria-label="Fermer" onClick={() => setOpenId(null)} className="rounded p-1 text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
              </div>
              {sel.description && <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">{sel.description}</p>}
              <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11.5px]">
                {([
                  ["Hôte", sel.host], ["IP source", sel.src_ip], ["IP destination", sel.dst_ip], ["Utilisateur", sel.user_name],
                  ["Règle", [sel.rule_id, sel.rule_name].filter(Boolean).join(" · ")], ["Gravité éditeur", sel.severity_raw],
                  ["MITRE", sel.mitre?.join(", ")], ["Procédure", sel.playbook], ["Occurrences", String(sel.occurrences)],
                  ["Source", sourceName(sel.source_id)],
                ] as Array<[string, string | null | undefined]>).filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="break-words">{v}</dd></div>
                ))}
              </dl>
              {sel.fp_verified?.length > 0 && (
                <div className="rounded-md bg-muted/50 px-3 py-2">
                  <div className="mb-1 font-medium">Faux positif, critères vérifiés</div>
                  <ul className="list-disc space-y-0.5 pl-4 text-[11.5px]">{sel.fp_verified.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </div>
              )}
              {sel.fp_hint_p != null && !sel.fp_verified?.length && (
                <div className="text-[11px] text-muted-foreground">Avis du modèle : {Math.round(sel.fp_hint_p * 100)} % de chances d'activité légitime, un indice, pas une preuve.</div>
              )}
              {actions.filter((x) => x.alert_id === sel.id).map((x, i) => (
                <div key={i} className="rounded-md border border-border/60 px-3 py-2 text-[11.5px]">
                  <span className="font-medium">Remédiation {x.status === "pending" ? "à valider" : x.status}</span> — {x.remediation}
                </div>
              ))}
              {(sel.notes ?? []).map((n, i) => (
                <div key={i} className="rounded-md bg-muted/40 px-2.5 py-1.5 text-[11.5px]">
                  <div className="text-[10.5px] text-muted-foreground">{n.by} · {when(n.at)}</div>
                  <div className="whitespace-pre-wrap">{n.text}</div>
                </div>
              ))}
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="text-[12px]"
                placeholder="Constat, vérification faite, décision…" />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="h-7 text-[11.5px]" disabled={busy} onClick={() => setStatus("investigating")}>Enquêter</Button>
                <Button size="sm" variant="outline" className="h-7 text-[11.5px]" disabled={busy} onClick={() => setStatus("escalated")}>Escalader</Button>
                <Button size="sm" variant="outline" className="h-7 text-[11.5px]" disabled={busy} onClick={() => setStatus("closed_fp", true)}>Clore : faux positif</Button>
                <Button size="sm" className="h-7 text-[11.5px]" disabled={busy} onClick={() => setStatus("closed_resolved")}>Clore : résolue</Button>
              </div>
              {sel.raw != null && (
                <details className="text-[11px]">
                  <summary className="cursor-pointer text-muted-foreground">Charge utile d'origine</summary>
                  <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted/50 p-2 text-[10.5px]">{JSON.stringify(sel.raw, null, 2)}</pre>
                </details>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// ── Sources ──────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  webhook: "Webhook (l'outil envoie)", poll: "Interrogation d'API", internal: "Signaux internes", agent: "Agents (connecteurs)", manual: "Import manuel",
};
const INTERNAL_LABEL: Record<string, string> = {
  scan_findings: "Résultats des scans de sécurité", gov_incidents: "Incidents de gouvernance", policy_blocks: "Actions d'agents refusées par PolicyGuard",
};
const FIELD_LABEL: Record<string, string> = {
  title: "Titre", severity: "Gravité", host: "Hôte", src_ip: "IP source", dst_ip: "IP destination", user: "Utilisateur",
  rule_id: "Id de règle", rule_name: "Nom de règle", category: "Catégorie", external_id: "Id éditeur", occurred_at: "Date", description: "Description", mitre: "MITRE",
};

function SourcesTab({ sources, presets, workspaceId, projectId, onChange }: {
  sources: Source[]; presets: Preset[]; workspaceId: string; projectId: string; onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<{ id: string; token: string } | null>(null);
  const presetLabel = (k: string) => presets.find((p) => p.key === k)?.label ?? k;

  return (
    <div className="space-y-3">
      {freshToken && (
        <Card className="border-foreground/30">
          <CardContent className="space-y-2 p-4 text-[12px]">
            <div className="flex items-center gap-1.5 font-medium"><Warning className="h-3.5 w-3.5" weight="fill" /> Copiez cette adresse maintenant : le jeton ne sera plus affiché.</div>
            <CopyLine value={hookUrl(freshToken.token)} />
            <div className="text-muted-foreground">Le jeton peut aussi passer dans l'en-tête <code className="rounded bg-muted px-1">x-sentinel-token</code> (URL : <code className="rounded bg-muted px-1">?sentinel=hook</code>).</div>
            <Button size="sm" variant="outline" className="h-7 text-[11.5px]" onClick={() => setFreshToken(null)}>J'ai copié l'adresse</Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center border-b border-border/60 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">Sources branchées</div>
              <div className="text-[11.5px] text-muted-foreground">Chaque source a son préréglage d'éditeur ; la correspondance des champs se corrige sans déploiement.</div>
            </div>
            <Button size="sm" className="h-8 gap-1.5" onClick={() => setAdding((v) => !v)}><Plus className="h-3.5 w-3.5" /> Ajouter une source</Button>
          </div>
          {adding && (
            <NewSourceForm presets={presets} workspaceId={workspaceId} projectId={projectId}
              onDone={(r) => { setAdding(false); if (r?.token) setFreshToken({ id: r.id, token: r.token }); onChange(); }} />
          )}
          {sources.length === 0 && !adding ? (
            <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">Aucune source. Commencez par un webhook de votre SIEM, ou par les signaux internes.</div>
          ) : (
            <div className="divide-y divide-border/40">
              {sources.map((s) => (
                <div key={s.id} className="px-4 py-2.5 text-[12px]">
                  <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left" onClick={() => setOpenId(openId === s.id ? null : s.id)}>
                    <span className="font-medium">{s.name}</span>
                    <span className="text-muted-foreground">{presetLabel(s.vendor)} · {KIND_LABEL[s.kind] ?? s.kind}{s.kind === "internal" ? ` · ${INTERNAL_LABEL[s.poll?.internal ?? ""] ?? ""}` : ""}</span>
                    {!s.enabled && <span className="rounded bg-muted px-1.5 text-[10.5px]">désactivée</span>}
                    {s.last_error && <span className="flex items-center gap-1 text-[11px]"><Warning className="h-3 w-3" weight="fill" /> {s.last_error}</span>}
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {s.kind === "webhook" ? `jeton …${s.token_hint ?? "?"} · ` : ""}dernière alerte {when(s.last_seen_at)}
                      {s.kind === "poll" || s.kind === "internal" ? ` · interrogée ${when(s.last_polled_at)}` : ""}
                    </span>
                  </button>
                  {openId === s.id && (
                    <SourceTools source={s} presets={presets} onChange={onChange} onToken={(token) => setFreshToken({ id: s.id, token })} />
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CopyLine({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-[11px]">{value}</code>
      <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]"
        onClick={() => { void navigator.clipboard.writeText(value); toast.success("Copié"); }}>
        <Copy className="h-3 w-3" /> Copier
      </Button>
    </div>
  );
}

function NewSourceForm({ presets, workspaceId, projectId, onDone }: {
  presets: Preset[]; workspaceId: string; projectId: string; onDone: (r: { id: string; token: string | null } | null) => void;
}) {
  const [kind, setKind] = useState<"webhook" | "poll" | "internal" | "manual">("webhook");
  const [vendor, setVendor] = useState("generic");
  const [name, setName] = useState("");
  const [poll, setPoll] = useState({ url: "", method: "GET", body: "", auth: "bearer", header_name: "", internal: "scan_findings" });
  const [secret, setSecret] = useState("");
  const [interval, setInterval] = useState(5);
  const [busy, setBusy] = useState(false);
  const available = presets.filter((p) => kind === "webhook" ? p.delivery.includes("webhook") : kind === "poll" ? p.delivery.includes("poll") : p.key === "generic");
  const preset = presets.find((p) => p.key === vendor);
  useEffect(() => { if (!available.some((p) => p.key === vendor)) setVendor("generic"); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    setBusy(true);
    try {
      const r = await callEdge<{ id: string; token: string | null }>(ADMIN_FN, {
        action: "create_source", workspace_id: workspaceId, project_id: projectId,
        name: name.trim() || (kind === "internal" ? INTERNAL_LABEL[poll.internal] : preset?.label ?? "Source"),
        kind, vendor: kind === "internal" || kind === "manual" ? "generic" : vendor,
        poll: kind === "poll" || kind === "internal" ? poll : undefined,
        secret: kind === "poll" && secret ? secret : undefined,
        poll_interval_minutes: interval,
      });
      toast.success("Source créée");
      onDone(r);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Création impossible (réservée aux administrateurs)"); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-3 border-b border-border/60 bg-muted/20 px-4 py-3 text-[12px]">
      <div className="flex flex-wrap gap-1.5">
        {(["webhook", "poll", "internal", "manual"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)}
            className={cn("rounded-md border px-2.5 py-1.5", kind === k ? "border-foreground/40 bg-background font-medium" : "border-border text-muted-foreground")}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {(kind === "webhook" || kind === "poll") && (
        <div className="grid gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
          {available.map((p) => (
            <button key={p.key} type="button" onClick={() => setVendor(p.key)}
              className={cn("rounded-md border px-2.5 py-2 text-left", vendor === p.key ? "border-foreground/40 bg-background font-medium" : "border-border bg-background/50")}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      {preset && (kind === "webhook" || kind === "poll") && <p className="text-[11.5px] leading-relaxed text-muted-foreground">{preset.setup}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom de la source (ex. Wazuh production)" className="h-8 w-72 text-[12px]" />
        {(kind === "poll" || kind === "internal") && (
          <label className="flex items-center gap-1.5 text-muted-foreground">toutes les
            <Input type="number" min={1} value={interval} onChange={(e) => setInterval(Number(e.target.value) || 5)} className="h-8 w-16 text-[12px]" /> min</label>
        )}
      </div>
      {kind === "internal" && (
        <select value={poll.internal} onChange={(e) => setPoll({ ...poll, internal: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-[12px]">
          {Object.entries(INTERNAL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      )}
      {kind === "poll" && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <select value={poll.method} onChange={(e) => setPoll({ ...poll, method: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-[12px]">
              <option>GET</option><option>POST</option>
            </select>
            <Input value={poll.url} onChange={(e) => setPoll({ ...poll, url: e.target.value })} className="h-8 min-w-[320px] flex-1 text-[12px]"
              placeholder="https://… (utilisez {{since}} pour la date de la dernière interrogation)" />
          </div>
          {poll.method === "POST" && (
            <Textarea rows={3} value={poll.body} onChange={(e) => setPoll({ ...poll, body: e.target.value })} className="font-mono text-[11px]"
              placeholder='{"query":{"range":{"@timestamp":{"gte":"{{since}}"}}}}' />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <select value={poll.auth} onChange={(e) => setPoll({ ...poll, auth: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-[12px]">
              <option value="none">Sans authentification</option><option value="bearer">Jeton (Bearer)</option>
              <option value="basic">Identifiant:mot de passe (Basic)</option><option value="header">En-tête personnalisé</option>
            </select>
            {poll.auth === "header" && <Input value={poll.header_name} onChange={(e) => setPoll({ ...poll, header_name: e.target.value })} placeholder="Nom de l'en-tête" className="h-8 w-44 text-[12px]" />}
            {poll.auth !== "none" && <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Secret (chiffré, jamais réaffiché)" className="h-8 w-64 text-[12px]" />}
          </div>
        </div>
      )}
      {kind === "manual" && <p className="text-[11.5px] text-muted-foreground">Une fois créée, ouvrez la source pour coller un export JSON, NDJSON ou CEF.</p>}
      <Button size="sm" className="h-8" disabled={busy} onClick={create}>{busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Créer la source</Button>
    </div>
  );
}

function SourceTools({ source, presets, onChange, onToken }: {
  source: Source; presets: Preset[]; onChange: () => void; onToken: (token: string) => void;
}) {
  const [sample, setSample] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(source.mapping ?? {}).map(([k, v]) => [k, (v ?? []).join(", ")])));
  const [itemsPath, setItemsPath] = useState(source.items_path ?? "");
  const [preview, setPreview] = useState<Array<Record<string, unknown>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const preset = presets.find((p) => p.key === source.vendor);

  const run = async (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    try { return await callEdge<Record<string, unknown>>(ADMIN_FN, { source_id: source.id, ...body }); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Échec"); return null; }
    finally { setBusy(null); }
  };

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border/60 p-3">
      {preset && <p className="text-[11.5px] leading-relaxed text-muted-foreground">{preset.setup}</p>}
      <div className="flex flex-wrap gap-2">
        {source.kind === "webhook" && (
          <Button size="sm" variant="outline" className="h-7 text-[11.5px]" disabled={!!busy}
            onClick={async () => { const r = await run("rotate", { action: "rotate_token" }); if (r?.token) onToken(String(r.token)); }}>Nouveau jeton</Button>
        )}
        {(source.kind === "poll" || source.kind === "internal") && (
          <Button size="sm" variant="outline" className="h-7 text-[11.5px]" disabled={!!busy}
            onClick={async () => { const r = await run("poll", { action: "poll_now" }); if (r) { toast[r.ok ? "success" : "error"](r.ok ? `${r.created} nouvelle(s), ${r.duplicates} doublon(s)` : String(r.error ?? "Échec")); onChange(); } }}>
            {busy === "poll" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Interroger maintenant
          </Button>
        )}
        <Button size="sm" variant="outline" className="h-7 text-[11.5px]" disabled={!!busy}
          onClick={async () => { const r = await run("toggle", { action: "update_source", enabled: !source.enabled }); if (r) onChange(); }}>
          {source.enabled ? "Désactiver" : "Réactiver"}
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-[11.5px]" disabled={!!busy}
          onClick={async () => {
            if (!window.confirm(`Supprimer la source « ${source.name} » et toutes ses alertes ?`)) return;
            const r = await run("delete", { action: "delete_source" }); if (r) onChange();
          }}><Trash className="h-3 w-3" /> Supprimer</Button>
      </div>

      <div className="space-y-2">
        <div className="text-[11.5px] font-medium">Correspondance des champs</div>
        <p className="text-[11px] text-muted-foreground">Chemins essayés AVANT ceux du préréglage, séparés par des virgules (ex. <code>data.device.name</code>). Laisser vide = préréglage.</p>
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex items-center gap-2 text-[11.5px]"><span className="w-28 shrink-0 text-muted-foreground">Liste d'alertes</span>
            <Input value={itemsPath} onChange={(e) => setItemsPath(e.target.value)} placeholder="ex. hits.hits" className="h-7 text-[11.5px]" /></label>
          {Object.keys(FIELD_LABEL).map((k) => (
            <label key={k} className="flex items-center gap-2 text-[11.5px]"><span className="w-28 shrink-0 text-muted-foreground">{FIELD_LABEL[k]}</span>
              <Input value={mapping[k] ?? ""} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value })} className="h-7 text-[11.5px]" /></label>
          ))}
        </div>
        <Button size="sm" variant="outline" className="h-7 text-[11.5px]" disabled={!!busy}
          onClick={async () => { const r = await run("map", { action: "update_source", mapping, items_path: itemsPath }); if (r) { toast.success("Correspondance enregistrée"); onChange(); } }}>
          Enregistrer la correspondance
        </Button>
      </div>

      <div className="space-y-2">
        <div className="text-[11.5px] font-medium">{source.kind === "manual" || source.kind === "agent" ? "Importer ou prévisualiser" : "Prévisualiser avec un exemple"}</div>
        <Textarea rows={5} value={sample} onChange={(e) => setSample(e.target.value)} className="font-mono text-[11px]"
          placeholder="Collez une charge utile de l'outil (JSON, lot, NDJSON ou lignes CEF)" />
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="h-7 text-[11.5px]" disabled={!sample.trim() || !!busy}
            onClick={async () => { const r = await run("preview", { action: "preview", sample, mapping, items_path: itemsPath }); if (r) setPreview((r.alerts as Array<Record<string, unknown>>) ?? []); }}>
            Prévisualiser
          </Button>
          {(source.kind === "manual" || source.kind === "agent" || source.kind === "webhook") && (
            <Button size="sm" className="h-7 text-[11.5px]" disabled={!sample.trim() || !!busy}
              onClick={async () => { const r = await run("import", { action: "import", text: sample }); if (r) { toast.success(`${r.created} alerte(s) importée(s), ${r.duplicates} doublon(s)`); setSample(""); onChange(); } }}>
              Importer
            </Button>
          )}
        </div>
        {preview && (
          <div className="overflow-x-auto rounded-md border border-border/60">
            <table className="w-full text-[11px]">
              <thead><tr className="text-left text-muted-foreground">
                {["Titre", "Gravité", "Hôte", "IP source", "Utilisateur", "Règle", "Date"].map((h) => <th key={h} className="px-2 py-1 font-normal">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-border/30">
                {preview.map((a, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1">{String(a.title ?? "")}</td>
                    <td className="px-2 py-1">{a.severity != null ? PRIORITY_LABEL[Number(a.severity)] : "—"} {a.severity_raw ? `(${String(a.severity_raw)})` : ""}</td>
                    <td className="px-2 py-1">{String(a.host ?? "—")}</td>
                    <td className="px-2 py-1">{String(a.src_ip ?? "—")}</td>
                    <td className="px-2 py-1">{String(a.user_name ?? "—")}</td>
                    <td className="px-2 py-1">{String(a.rule_id ?? a.rule_name ?? "—")}</td>
                    <td className="px-2 py-1">{when(String(a.occurred_at ?? ""))}</td>
                  </tr>
                ))}
                {preview.length === 0 && <tr><td colSpan={7} className="px-2 py-2 text-muted-foreground">Aucune alerte reconnue dans cet exemple.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Actifs ───────────────────────────────────────────────────────────────────

interface AssetRow { id?: string; name: string; ips: string[]; criticality: string; owner: string | null; tags: string[] }

function AssetsTab({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const qc = useQueryClient();
  const { data: assets } = useQuery({
    queryKey: ["sentinel_assets", projectId],
    queryFn: async () => ((await supabase.from("sentinel_assets").select("id, name, ips, criticality, owner, tags").eq("project_id", projectId).order("name")).data ?? []) as AssetRow[],
  });
  const [draft, setDraft] = useState<AssetRow>({ name: "", ips: [], criticality: "medium", owner: "", tags: [] });
  const reload = () => qc.invalidateQueries({ queryKey: ["sentinel_assets", projectId] });

  async function add() {
    if (!draft.name.trim()) return;
    const { error } = await supabase.from("sentinel_assets").insert({ ...draft, name: draft.name.trim(), workspace_id: workspaceId, project_id: projectId });
    if (error) { toast.error(error.message); return; }
    setDraft({ name: "", ips: [], criticality: "medium", owner: "", tags: [] });
    reload();
  }
  async function patch(id: string, p: Partial<AssetRow>) {
    const { error } = await supabase.from("sentinel_assets").update(p).eq("id", id);
    if (error) toast.error(error.message); else reload();
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4 text-[12px]">
        <p className="text-[11.5px] text-muted-foreground">
          Un actif <strong className="text-foreground">critique</strong> ou <strong className="text-foreground">élevé</strong> fait monter la priorité de ses alertes d'un cran.
          Les étiquettes <code>test</code>, <code>scanner</code>, <code>honeypot</code>, <code>lab</code>, <code>sandbox</code> sont des critères de faux positif vérifiables.
        </p>
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/30 p-2">
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Nom d'hôte" className="h-8 w-44 text-[12px]" />
          <Input value={draft.ips.join(", ")} onChange={(e) => setDraft({ ...draft, ips: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="IP (séparées par des virgules)" className="h-8 w-52 text-[12px]" />
          <select value={draft.criticality} onChange={(e) => setDraft({ ...draft, criticality: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-[12px]">
            <option value="low">Criticité faible</option><option value="medium">Moyenne</option><option value="high">Élevée</option><option value="critical">Critique</option>
          </select>
          <Input value={draft.owner ?? ""} onChange={(e) => setDraft({ ...draft, owner: e.target.value })} placeholder="Responsable" className="h-8 w-36 text-[12px]" />
          <Input value={draft.tags.join(", ")} onChange={(e) => setDraft({ ...draft, tags: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="Étiquettes" className="h-8 w-40 text-[12px]" />
          <Button size="sm" className="h-8 gap-1" onClick={add}><Plus className="h-3.5 w-3.5" /> Ajouter</Button>
        </div>
        <div className="divide-y divide-border/40">
          {(assets ?? []).map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="w-44 font-medium">{a.name}</span>
              <span className="w-52 truncate text-muted-foreground">{a.ips.join(", ") || "—"}</span>
              <select value={a.criticality} onChange={(e) => patch(a.id!, { criticality: e.target.value })} className="h-7 rounded-md border border-input bg-background px-1.5 text-[11.5px]">
                <option value="low">Faible</option><option value="medium">Moyenne</option><option value="high">Élevée</option><option value="critical">Critique</option>
              </select>
              <span className="text-muted-foreground">{a.owner || "—"}</span>
              <span className="text-muted-foreground">{a.tags.join(", ")}</span>
              <button type="button" aria-label="Supprimer" className="ml-auto rounded p-1 hover:bg-muted"
                onClick={async () => { await supabase.from("sentinel_assets").delete().eq("id", a.id!); reload(); }}><Trash className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          {(assets ?? []).length === 0 && <div className="py-4 text-center text-muted-foreground">Aucun actif déclaré.</div>}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Règles & procédures ──────────────────────────────────────────────────────

const DEFAULT_PLAYBOOKS = [
  { key: "enqueter", label: "Enquêter", what: "Rassembler le contexte (journaux, autres alertes de l'hôte ou de l'utilisateur) avant de conclure ; aucune action sur les systèmes." },
  { key: "isoler_poste", label: "Isoler le poste", what: "Un poste ou serveur montre une exécution malveillante, un ransomware ou un contrôle à distance : le couper du réseau." },
  { key: "reinitialiser_compte", label: "Réinitialiser le compte", what: "Un compte est probablement compromis : révoquer les sessions et changer les identifiants." },
  { key: "bloquer_ip", label: "Bloquer l'adresse", what: "Une adresse externe attaque ou exfiltre : la bloquer au pare-feu, au WAF ou au proxy." },
  { key: "corriger", label: "Corriger la vulnérabilité", what: "Une faiblesse exploitable est exposée : corriger, faire tourner le secret, mettre à jour." },
  { key: "clore", label: "Clore sans action", what: "Activité légitime ou bruit : documenter la raison et clore." },
];

interface Suppression { id?: string; label: string; match: Record<string, string>; reason: string | null; expires_at: string | null; enabled: boolean }

function RulesTab({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["sentinel_rules", projectId],
    queryFn: async () => {
      const [s, c] = await Promise.all([
        supabase.from("sentinel_suppressions").select("id, label, match, reason, expires_at, enabled").eq("project_id", projectId).order("created_at"),
        supabase.from("sentinel_config").select("config").eq("project_id", projectId).maybeSingle(),
      ]);
      return { sups: (s.data ?? []) as Suppression[], config: ((c.data as { config?: Record<string, unknown> } | null)?.config ?? {}) as Record<string, unknown> };
    },
  });
  const [draft, setDraft] = useState<Suppression>({ label: "", match: {}, reason: "", expires_at: null, enabled: true });
  const [cfg, setCfg] = useState<{ playbooks: typeof DEFAULT_PLAYBOOKS; auto_close_verified_fp: boolean; fp_rate_threshold: number; fp_rate_min_samples: number } | null>(null);
  useEffect(() => {
    if (!data) return;
    const c = data.config;
    setCfg({
      playbooks: Array.isArray(c.playbooks) && (c.playbooks as unknown[]).length >= 2 ? c.playbooks as typeof DEFAULT_PLAYBOOKS : DEFAULT_PLAYBOOKS,
      auto_close_verified_fp: c.auto_close_verified_fp === true,
      fp_rate_threshold: Number(c.fp_rate_threshold ?? 0.9),
      fp_rate_min_samples: Number(c.fp_rate_min_samples ?? 10),
    });
  }, [data]);
  const reload = () => qc.invalidateQueries({ queryKey: ["sentinel_rules", projectId] });

  async function addSup() {
    const match = Object.fromEntries(Object.entries(draft.match).filter(([, v]) => v.trim()));
    if (!draft.label.trim() || !Object.keys(match).length) { toast.error("Un nom et au moins un critère."); return; }
    const { data: auth } = await supabase.auth.getUser();
    const { error } = await supabase.from("sentinel_suppressions").insert({
      workspace_id: workspaceId, project_id: projectId, label: draft.label.trim(), match,
      reason: draft.reason?.trim() || null, expires_at: draft.expires_at || null, enabled: true, created_by: auth.user?.id ?? null,
    });
    if (error) { toast.error(error.message); return; }
    setDraft({ label: "", match: {}, reason: "", expires_at: null, enabled: true });
    reload();
  }
  async function saveCfg() {
    if (!cfg) return;
    const { error } = await supabase.from("sentinel_config").upsert({ project_id: projectId, workspace_id: workspaceId, config: cfg, updated_at: new Date().toISOString() }, { onConflict: "project_id" });
    if (error) toast.error(error.message); else { toast.success("Réglages enregistrés"); reload(); }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4 text-[12px]">
          <div>
            <div className="text-[13px] font-medium">Règles de suppression</div>
            <p className="text-[11.5px] text-muted-foreground">Une alerte qui correspond à TOUS les critères renseignés est un faux positif prouvé. Donnez toujours la raison, et une date de fin quand c'est temporaire (maintenance, test).</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/30 p-2">
            <Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Nom de la règle" className="h-8 w-48 text-[12px]" />
            {(["rule_id", "host", "src_ip", "user", "category", "title_contains"] as const).map((k) => (
              <Input key={k} value={draft.match[k] ?? ""} onChange={(e) => setDraft({ ...draft, match: { ...draft.match, [k]: e.target.value } })}
                placeholder={{ rule_id: "Id de règle", host: "Hôte", src_ip: "IP source", user: "Utilisateur", category: "Catégorie éditeur", title_contains: "Titre contient" }[k]}
                className="h-8 w-32 text-[12px]" />
            ))}
            <Input value={draft.reason ?? ""} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} placeholder="Raison" className="h-8 w-56 text-[12px]" />
            <Input type="date" value={draft.expires_at ?? ""} onChange={(e) => setDraft({ ...draft, expires_at: e.target.value || null })} className="h-8 w-36 text-[12px]" />
            <Button size="sm" className="h-8 gap-1" onClick={addSup}><Plus className="h-3.5 w-3.5" /> Ajouter</Button>
          </div>
          <div className="divide-y divide-border/40">
            {(data?.sups ?? []).map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="font-medium">{s.label}</span>
                <span className="text-muted-foreground">{Object.entries(s.match).map(([k, v]) => `${k} = ${v}`).join(" · ")}</span>
                {s.reason && <span className="text-muted-foreground">— {s.reason}</span>}
                {s.expires_at && <span className="text-muted-foreground">jusqu'au {new Date(s.expires_at).toLocaleDateString("fr-FR")}</span>}
                <label className="ml-auto flex items-center gap-1.5 text-[11.5px]">
                  <input type="checkbox" checked={s.enabled} onChange={async (e) => { await supabase.from("sentinel_suppressions").update({ enabled: e.target.checked }).eq("id", s.id!); reload(); }} /> active
                </label>
                <button type="button" aria-label="Supprimer" className="rounded p-1 hover:bg-muted"
                  onClick={async () => { await supabase.from("sentinel_suppressions").delete().eq("id", s.id!); reload(); }}><Trash className="h-3.5 w-3.5" /></button>
              </div>
            ))}
            {(data?.sups ?? []).length === 0 && <div className="py-3 text-center text-muted-foreground">Aucune règle de suppression.</div>}
          </div>
        </CardContent>
      </Card>

      {cfg && (
        <Card>
          <CardContent className="space-y-3 p-4 text-[12px]">
            <div className="flex items-center">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">Procédures et faux positifs</div>
                <p className="text-[11.5px] text-muted-foreground">Les procédures sont ce que le triage peut recommander ; il ne les exécute jamais.</p>
              </div>
              <Button size="sm" className="h-8" onClick={saveCfg}>Enregistrer</Button>
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={cfg.auto_close_verified_fp} onChange={(e) => setCfg({ ...cfg, auto_close_verified_fp: e.target.checked })} />
              Clore automatiquement une alerte dont le faux positif est prouvé (sinon, elle est seulement marquée)
            </label>
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
              Une règle devient un critère de faux positif quand elle a été close en faux positif dans
              <Input type="number" step="0.05" min={0.5} max={1} value={cfg.fp_rate_threshold} onChange={(e) => setCfg({ ...cfg, fp_rate_threshold: Number(e.target.value) })} className="h-7 w-20 text-[12px]" />
              des cas, sur au moins
              <Input type="number" min={3} value={cfg.fp_rate_min_samples} onChange={(e) => setCfg({ ...cfg, fp_rate_min_samples: Number(e.target.value) })} className="h-7 w-16 text-[12px]" />
              alertes (30 jours).
            </div>
            <div className="space-y-1.5">
              {cfg.playbooks.map((p, i) => (
                <div key={i} className="flex flex-wrap gap-2">
                  <Input value={p.label} onChange={(e) => setCfg({ ...cfg, playbooks: cfg.playbooks.map((x, j) => j === i ? { ...x, label: e.target.value, key: x.key || e.target.value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_") } : x) })} className="h-8 w-48 text-[12px]" />
                  <Input value={p.what} onChange={(e) => setCfg({ ...cfg, playbooks: cfg.playbooks.map((x, j) => j === i ? { ...x, what: e.target.value } : x) })} className="h-8 min-w-[280px] flex-1 text-[12px]" placeholder="Quand appliquer cette procédure" />
                  <button type="button" aria-label="Retirer" className="rounded p-1 hover:bg-muted" onClick={() => setCfg({ ...cfg, playbooks: cfg.playbooks.filter((_, j) => j !== i) })}><Trash className="h-3.5 w-3.5" /></button>
                </div>
              ))}
              <Button size="sm" variant="outline" className="h-7 gap-1 text-[11.5px]" onClick={() => setCfg({ ...cfg, playbooks: [...cfg.playbooks, { key: "", label: "Nouvelle procédure", what: "" }] })}>
                <Plus className="h-3 w-3" /> Ajouter une procédure
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Remédiations ─────────────────────────────────────────────────────────────

function RemediationsTab({ actions, alerts, onChange }: {
  actions: Array<{ id: string; alert_id: string; playbook: string | null; remediation: string; justification: string | null; status: string; decided_at: string | null; decision_note: string | null; created_at: string }>;
  alerts: Alert[]; onChange: () => void;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  async function decide(id: string, status: "approved" | "rejected" | "done") {
    const { data: auth } = await supabase.auth.getUser();
    const { error } = await supabase.from("sentinel_actions").update({
      status, decided_by: auth.user?.id ?? null, decided_at: new Date().toISOString(), decision_note: notes[id]?.trim() || null,
    }).eq("id", id);
    if (error) toast.error(error.message); else onChange();
  }
  if (actions.length === 0) {
    return <Card className="border-dashed"><CardContent className="p-5 text-[12.5px] text-muted-foreground">Aucune remédiation proposée. Un agent doté de l'outil SentinelFlow en propose ici ; rien ne s'exécute sans votre validation.</CardContent></Card>;
  }
  return (
    <Card>
      <CardContent className="divide-y divide-border/40 p-0 text-[12px]">
        {actions.map((x) => {
          const alert = alerts.find((a) => a.id === x.alert_id);
          return (
            <div key={x.id} className="space-y-1.5 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{x.remediation}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {x.status === "pending" ? "à valider" : x.status === "approved" ? "validée" : x.status === "rejected" ? "refusée" : "faite"} · {when(x.decided_at ?? x.created_at)}
                </span>
              </div>
              <div className="text-[11.5px] text-muted-foreground">
                {alert ? `Alerte : ${alert.title}${alert.host ? ` · ${alert.host}` : ""}` : "Alerte hors période"}{x.playbook ? ` · procédure ${x.playbook}` : ""}
              </div>
              {x.justification && <p className="whitespace-pre-wrap text-[11.5px]">{x.justification}</p>}
              {x.decision_note && <p className="text-[11.5px] text-muted-foreground">Décision : {x.decision_note}</p>}
              {x.status === "pending" && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input value={notes[x.id] ?? ""} onChange={(e) => setNotes({ ...notes, [x.id]: e.target.value })} placeholder="Note de décision (facultatif)" className="h-7 w-72 text-[11.5px]" />
                  <Button size="sm" className="h-7 gap-1 text-[11.5px]" onClick={() => decide(x.id, "approved")}><Check className="h-3 w-3" /> Valider</Button>
                  <Button size="sm" variant="outline" className="h-7 gap-1 text-[11.5px]" onClick={() => decide(x.id, "rejected")}><X className="h-3 w-3" /> Refuser</Button>
                </div>
              )}
              {x.status === "approved" && (
                <Button size="sm" variant="outline" className="h-7 text-[11.5px]" onClick={() => decide(x.id, "done")}>Marquer comme faite</Button>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
