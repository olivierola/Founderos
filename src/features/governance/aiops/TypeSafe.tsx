import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ScalesIcon as Scales,
  CircleNotchIcon as Loader2,
  CheckIcon as Check,
  WarningIcon as Warning,
  EyeIcon as Eye,
  PowerIcon as Power,
  LightningIcon as Lightning,
  ArrowClockwiseIcon as Refresh,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

// Le pilotage du jugement rapide (TypeSafe / Jev).
//
// Cet écran existe pour une raison précise : on branche un fournisseur d'un
// mois sur des décisions qui comptent (bloquer un message, choisir un agent,
// déclarer un run terminé), et il faut pouvoir l'éteindre en une seconde, sans
// déploiement, sans migration.
//
// D'où les trois états par usage, et le mode du milieu qui fait tout
// l'intérêt : en OBSERVATION, l'appel est fait, la réponse est journalisée, et
// le code garde son comportement actuel. On compare sur des données réelles
// pendant une semaine, puis on décide.

type Mode = "off" | "shadow" | "on";

interface FeatureConfig { mode: Mode; threshold: number }

/** Le catalogue, copie de celui du runtime (_shared/typesafe.ts). Volontairement
 *  dupliqué : le navigateur ne peut pas importer un module Deno, et une liste
 *  d'usages est du texte, pas une règle — la divergence se verrait ici, sur un
 *  libellé, pas dans une décision. */
const FEATURES: Array<{
  feature: string;
  label: string;
  effect: string;
  where: string;
  thresholdLabel: string;
  defaultThreshold: number;
}> = [
  {
    feature: "guardrails",
    label: "Garde-fous sémantiques",
    effect: "Les règles écrites en français dans Guardrails deviennent applicables : elles sont évaluées par le sens, pas seulement par leur expression régulière.",
    where: "Agents internes (prompt, appel d'outil, résultat) · Agents publics (message reçu, réponse envoyée)",
    thresholdLabel: "Probabilité minimale pour bloquer",
    defaultThreshold: 0.75,
  },
  {
    feature: "skill_ranking",
    label: "Choix des skills",
    effect: "Les skills envoyées dans le prompt sont classées par le modèle au lieu de l'être par correspondance de mots.",
    where: "Démarrage d'un chat et d'une mission",
    thresholdLabel: "Probabilité minimale pour remonter une skill",
    defaultThreshold: 0.05,
  },
  {
    feature: "tool_ranking",
    label: "Choix des outils",
    effect: "La famille d'outils utile à la tâche passe devant les autres dans les schémas envoyés au modèle.",
    where: "Début de chaque tick de run",
    thresholdLabel: "Confiance minimale pour appliquer le choix",
    defaultThreshold: 0.5,
  },
  {
    feature: "search_decision",
    label: "Décision de recherche",
    effect: "Le tour dit s'il faut aller chercher (web, connaissances, données) ou si tout est déjà là — et les outils de recherche montent ou descendent en conséquence.",
    where: "Début de chaque tick de run",
    thresholdLabel: "Probabilité au-delà de laquelle il faut chercher",
    defaultThreshold: 0.6,
  },
  {
    feature: "agent_choice",
    label: "Choix de l'agent",
    effect: "Le routage d'une room tranche « je réponds / je passe à X » sans appel génératif quand il est sûr. Un doute repasse la main au routeur d'avant.",
    where: "Rooms de service · Recherche d'équipier (list_team_agents)",
    thresholdLabel: "Confiance minimale pour trancher seul",
    defaultThreshold: 0.8,
  },
  {
    feature: "run_end",
    label: "Fin de run",
    effect: "La vérification du contrat de réussite se fait en un appel typé, avec une probabilité par critère, au lieu d'un appel génératif.",
    where: "Finalisation d'un run d'agent",
    thresholdLabel: "Probabilité minimale pour déclarer un critère rempli",
    defaultThreshold: 0.6,
  },
  {
    feature: "rag_rerank",
    label: "ContextIQ — filtre de contexte RAG",
    effect: "Les passages récupérés sont notés de 0 à 3 et les hors-sujet écartés ; la couverture de la question et les contradictions sont jugées. Couverture faible : la recherche s'élargit, puis l'agent dit « je ne sais pas » au lieu d'inventer. Détail dans Gouvernance IA → ContextIQ.",
    where: "Agents publics (widget, portail) · Agents internes (search_knowledge, choix des collections)",
    thresholdLabel: "Note minimale (0-3) pour garder un passage",
    defaultThreshold: 1,
  },
  {
    feature: "approval_risk",
    label: "Risque d'une action",
    effect: "Une action jugée irréversible passe en approbation même si son nom ne la trahit pas. N'enlève jamais une approbation existante.",
    where: "Actions de connecteurs (Composio)",
    thresholdLabel: "Probabilité d'irréversibilité qui déclenche l'approbation",
    // Bas exprès : ici l'erreur chère est de RATER une action destructrice, pas
    // d'en faire valider une de trop.
    defaultThreshold: 0.5,
  },
  {
    feature: "browser_target",
    label: "Ciblage dans le navigateur",
    effect: "L'agent dit ce qu'il veut atteindre (« le bouton qui valide la commande ») et l'élément est choisi dans la page. Sans ça, chaque clic coûte un aller-retour génératif avec toute la liste des éléments.",
    where: "Pilotage du navigateur de l'utilisateur (extension) — actions click, fill, select, check, press",
    thresholdLabel: "Confiance minimale pour agir sur l'élément choisi",
    // Haut : un clic au mauvais endroit dans le navigateur de quelqu'un est une
    // action réelle, immédiate, et souvent irréversible.
    defaultThreshold: 0.75,
  },
  {
    feature: "workflow_judge",
    label: "Condition jugée (workflows)",
    effect: "Active le bloc « Condition jugée » : une question en français tranchée dans une automatisation, avec sa probabilité journalisée à l'étape.",
    where: "Moteur d'automatisation",
    thresholdLabel: "Probabilité au-delà de laquelle la condition est vraie",
    defaultThreshold: 0.6,
  },
  {
    feature: "model_choice",
    label: "AgentPilot — choix du modèle",
    effect: "Le modèle de raisonnement n'est pris que quand la tâche l'exige vraiment (analyse, diagnostic, plan sous contraintes), au lieu d'une liste de mots-clés. Ne touche jamais un modèle choisi dans le composer.",
    where: "Démarrage d'un chat et d'une mission · Détail dans Gouvernance IA → AgentPilot",
    thresholdLabel: "Probabilité minimale pour prendre le modèle de raisonnement",
    defaultThreshold: 0.7,
  },
  {
    feature: "loop_watch",
    label: "AgentPilot — boucles déguisées",
    effect: "Une boucle de reformulations (la même recherche sous cinq formes) déclenche la replanification, comme une boucle d'appels identiques.",
    where: "Fin de chaque tick de run, quand aucun autre garde-fou n'a sonné",
    thresholdLabel: "Probabilité minimale pour déclarer une boucle",
    // Haut : une fausse boucle coûte une replanification ET le modèle lourd.
    defaultThreshold: 0.75,
  },
  {
    feature: "human_escalation",
    label: "AgentPilot — escalade vers l'humain",
    effect: "Quand un blocage dépend d'un accès, d'un document ou d'une décision de l'utilisateur, l'agent pose la question (ask_user) au lieu de replanifier dans le vide.",
    where: "Au moment où le contrôleur de boucle s'apprête à replanifier",
    thresholdLabel: "Probabilité minimale pour poser la question",
    defaultThreshold: 0.7,
  },
  {
    feature: "support_triage",
    label: "ResolveAI — tri des demandes",
    effect: "Chaque message reçu par un agent public est classé (intention, urgence, besoin d'une personne). Une demande qui relève de l'équipe reçoit une réponse prudente qui annonce le relais, et entre dans la file avec son échéance SLA.",
    where: "Agents publics (widget, playground) · File dans l'onglet « Demandes » de chaque agent public",
    thresholdLabel: "Probabilité minimale pour confier la demande à l'équipe",
    // Bas : laisser l'agent répondre seul à une demande de remboursement coûte
    // plus cher que d'en confier une de trop à l'équipe.
    defaultThreshold: 0.55,
  },
  {
    feature: "policy_guard",
    label: "PolicyGuard — risque des actions",
    effect: "Chaque action d'écriture d'un agent reçoit un niveau de risque (0 lecture → 3 irréversible), confronté à la grille de son équipe : approbation, refus, ou plafond de l'autopilote. Ne retire jamais une approbation existante.",
    where: "Actions de connecteurs, Composio, CRM, suivi de travail, fonctions internes, webhooks · Grille dans Gouvernance IA → PolicyGuard",
    thresholdLabel: "Seuil (non utilisé : c'est la grille de l'équipe qui décide)",
    defaultThreshold: 0.5,
  },
  {
    feature: "lead_scoring",
    label: "LeadSense — qualification",
    effect: "L'outil lead_sense des agents internes qualifie un prospect sur la grille de l'entreprise (type, critères, score, rang, prospect chaud, commercial). Éteint, l'outil refuse de noter plutôt que de deviner. En Observation, il note quand même — c'est sa raison d'être — et le prospect est marqué « observation ».",
    where: "Outil « LeadSense » des agents internes · Grille dans le réglage de l'outil",
    thresholdLabel: "Probabilité minimale pour déclarer un prospect chaud",
    defaultThreshold: 0.6,
  },
  {
    feature: "soc_triage",
    label: "SentinelFlow — triage des alertes",
    effect: "Chaque alerte de sécurité reçue est classée (catégorie, situation réelle, procédure) et les cas urgents sont escaladés. Un faux positif n'est jamais décidé par le modèle : seulement par des critères vérifiables (suppression, actif de test, scan autorisé, historique).",
    where: "Toutes les sources SentinelFlow (webhooks, interrogations, signaux internes, agents, imports) · Gouvernance IA → SentinelFlow",
    thresholdLabel: "Probabilité minimale pour escalader à un analyste",
    defaultThreshold: 0.7,
  },
];

const MODE_META: Record<Mode, { label: string; hint: string; tone: string; icon: typeof Power }> = {
  off: {
    label: "Éteint", icon: Power,
    hint: "Aucun appel n'est fait.",
    tone: "bg-muted text-muted-foreground",
  },
  shadow: {
    label: "Observation", icon: Eye,
    hint: "L'appel est fait et journalisé, mais la réponse n'est pas utilisée.",
    tone: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  on: {
    label: "Actif", icon: Lightning,
    hint: "La réponse est utilisée.",
    tone: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
};

export function GovTypeSafePage() {
  const { workspaceId } = useCurrentContext();
  const qc = useQueryClient();
  const [saving, setSaving] = useState<string | null>(null);

  const { data: settings, isLoading } = useQuery({
    queryKey: ["typesafe_settings", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase.from("typesafe_settings")
        .select("features").eq("workspace_id", workspaceId!).maybeSingle();
      return ((data as { features?: Record<string, FeatureConfig> } | null)?.features ?? {});
    },
  });

  const { data: stats } = useQuery({
    queryKey: ["typesafe_stats", workspaceId],
    enabled: !!workspaceId,
    refetchInterval: 30_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
      const { data } = await supabase.from("typesafe_judgements")
        .select("feature, mode, applied, confidence, latency_ms, cost_cents, error, created_at")
        .eq("workspace_id", workspaceId!)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(2000);
      return (data ?? []) as Array<{
        feature: string; mode: string; applied: boolean; confidence: number | null;
        latency_ms: number | null; cost_cents: number | null; error: string | null; created_at: string;
      }>;
    },
  });

  const byFeature = useMemo(() => {
    const out = new Map<string, {
      calls: number; errors: number; applied: number;
      latency: number[]; cost: number; confidence: number[];
    }>();
    for (const row of stats ?? []) {
      const acc = out.get(row.feature) ?? { calls: 0, errors: 0, applied: 0, latency: [], cost: 0, confidence: [] };
      acc.calls++;
      if (row.error) acc.errors++;
      if (row.applied) acc.applied++;
      if (row.latency_ms != null) acc.latency.push(row.latency_ms);
      acc.cost += Number(row.cost_cents ?? 0);
      if (row.confidence != null) acc.confidence.push(Number(row.confidence));
      out.set(row.feature, acc);
    }
    return out;
  }, [stats]);

  const configOf = (feature: string): FeatureConfig => {
    const row = (settings ?? {})[feature];
    const meta = FEATURES.find((f) => f.feature === feature);
    return {
      mode: row?.mode === "on" || row?.mode === "shadow" ? row.mode : "off",
      threshold: Number.isFinite(Number(row?.threshold)) && row?.threshold != null
        ? Number(row.threshold)
        : meta?.defaultThreshold ?? 0.7,
    };
  };

  async function write(feature: string, patch: Partial<FeatureConfig>) {
    if (!workspaceId) return;
    setSaving(feature);
    try {
      const next = { ...(settings ?? {}), [feature]: { ...configOf(feature), ...patch } };
      await supabase.from("typesafe_settings").upsert({
        workspace_id: workspaceId,
        features: next,
        updated_at: new Date().toISOString(),
      }, { onConflict: "workspace_id" });
      qc.invalidateQueries({ queryKey: ["typesafe_settings", workspaceId] });
    } finally {
      setSaving(null);
    }
  }

  const anyOn = FEATURES.some((f) => configOf(f.feature).mode !== "off");
  const totalCost = [...byFeature.values()].reduce((n, a) => n + a.cost, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Jugement rapide"
        description="Un modèle « System One » (TypeSafe · Jev) tranche les micro-décisions que l'on paie aujourd'hui en raisonnement : quelle skill charger, quel agent est le bon, ce run est-il fini, ce message est-il dangereux. Il ne rédige rien — il décide autour de ce qui rédige."
        actions={
          <Button variant="outline" size="sm" className="gap-1.5"
            onClick={() => { qc.invalidateQueries({ queryKey: ["typesafe_stats", workspaceId] }); }}>
            <Refresh className="h-3.5 w-3.5" /> Rafraîchir
          </Button>
        }
      />

      {/* La clé vit dans les secrets de la fonction edge : l'écran ne peut pas
          la vérifier, il dit donc où elle se pose plutôt que d'annoncer un état
          qu'il ne connaît pas. */}
      <Card className="border-dashed">
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-[12px]">
          <span className="flex items-center gap-1.5 font-medium">
            <Scales className="h-4 w-4 text-purple-500" /> Avant d'activer
          </span>
          <span className="text-muted-foreground">
            Posez le secret <code className="rounded bg-muted px-1 font-mono text-[11px]">TYPESAFE_API_KEY</code> sur
            les fonctions edge. Sans lui, tout reste éteint quel que soit le réglage ci-dessous.
          </span>
          {totalCost > 0 && (
            <span className="ml-auto text-muted-foreground">
              7 derniers jours : <span className="font-medium text-foreground">{(totalCost / 100).toFixed(3)} €</span>
              {" "}· {(stats ?? []).length} jugement{(stats ?? []).length > 1 ? "s" : ""}
            </span>
          )}
        </CardContent>
      </Card>

      {!anyOn && (
        <p className="rounded-xl bg-sky-500/5 px-4 py-3 text-[12.5px] leading-relaxed text-sky-700 dark:text-sky-300">
          Tout est éteint. Commencez par mettre un usage en <strong>Observation</strong> : l'appel se fait, la réponse
          est journalisée, et rien ne change dans le produit. Au bout de quelques jours, la colonne « appliqué » et la
          confiance moyenne disent si le passage en <strong>Actif</strong> se défend.
        </p>
      )}

      {isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-3">
          {FEATURES.map((f) => {
            const cfg = configOf(f.feature);
            const s = byFeature.get(f.feature);
            const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
            const latency = avg(s?.latency ?? []);
            const confidence = avg(s?.confidence ?? []);
            return (
              <Card key={f.feature} className={cn(cfg.mode === "on" && "border-emerald-500/40")}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-[14px] font-semibold">{f.label}</h3>
                        <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", MODE_META[cfg.mode].tone)}>
                          {MODE_META[cfg.mode].label}
                        </span>
                        {saving === f.feature && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                      </div>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{f.effect}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground/80">{f.where}</p>
                    </div>

                    <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
                      {(["off", "shadow", "on"] as Mode[]).map((m) => {
                        const meta = MODE_META[m];
                        const Icon = meta.icon;
                        return (
                          <button
                            key={m} type="button" title={meta.hint}
                            onClick={() => write(f.feature, { mode: m })}
                            className={cn(
                              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11.5px] transition-colors",
                              cfg.mode === m ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            <Icon className="h-3.5 w-3.5" /> {meta.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border/50 pt-3">
                    <label className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                      {f.thresholdLabel}
                      <Input
                        type="number" step="0.05" min="0" max="3"
                        value={cfg.threshold}
                        onChange={(e) => write(f.feature, { threshold: Number(e.target.value) })}
                        className="h-7 w-20 text-[12px]"
                      />
                    </label>

                    {s ? (
                      <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                        <span>{s.calls} appel{s.calls > 1 ? "s" : ""} / 7 j</span>
                        <span className={cn(s.applied > 0 && "text-emerald-600 dark:text-emerald-400")}>
                          {s.applied} appliqué{s.applied > 1 ? "s" : ""}
                        </span>
                        {confidence != null && <span>confiance moy. {confidence.toFixed(2)}</span>}
                        {latency != null && <span>{Math.round(latency)} ms</span>}
                        <span>{(s.cost / 100).toFixed(4)} €</span>
                        {s.errors > 0 && (
                          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                            <Warning className="h-3 w-3" /> {s.errors} en erreur
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/70">aucun jugement sur 7 jours</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <RecentJudgements rows={stats ?? []} />
    </div>
  );
}

/** Les vingt derniers jugements. C'est ce qu'on lit en mode Observation : la
 *  décision qu'il AURAIT prise, avec sa confiance et son coût. */
function RecentJudgements({ rows }: {
  rows: Array<{
    feature: string; mode: string; applied: boolean; confidence: number | null;
    latency_ms: number | null; cost_cents: number | null; error: string | null; created_at: string;
  }>;
}) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardContent className="p-0">
        <div className="border-b border-border/60 px-4 py-2.5 text-[12px] font-medium">Derniers jugements</div>
        <div className="divide-y divide-border/40">
          {rows.slice(0, 20).map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-[11.5px]">
              <span className="w-40 shrink-0 truncate font-medium">
                {FEATURES.find((f) => f.feature === r.feature)?.label ?? r.feature}
              </span>
              <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px]", MODE_META[(r.mode as Mode) ?? "off"]?.tone)}>
                {MODE_META[(r.mode as Mode) ?? "off"]?.label ?? r.mode}
              </span>
              {r.applied
                ? <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><Check className="h-3 w-3" /> appliqué</span>
                : <span className="text-muted-foreground">non appliqué</span>}
              {r.confidence != null && <span className="text-muted-foreground">confiance {Number(r.confidence).toFixed(2)}</span>}
              {r.latency_ms != null && <span className="text-muted-foreground">{r.latency_ms} ms</span>}
              {r.error && <span className="truncate text-amber-600 dark:text-amber-400">{r.error}</span>}
              <span className="ml-auto shrink-0 text-muted-foreground/70">
                {new Date(r.created_at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
