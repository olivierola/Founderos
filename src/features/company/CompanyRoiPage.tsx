// ROI de la workforce — ce que l'IA rapporte, en face de ce qu'elle coûte.
//
// Le produit savait déjà tout dire sur le coût (crédits, usage, facturation) et
// rien sur la valeur. Un dirigeant y lisait « 1 843 runs d'agents » : une
// mesure d'activité, pas une mesure de valeur, et la phrase qu'on ne peut pas
// défendre en renouvellement.
//
// La règle de cet écran est qu'il ne ment pas :
//
//   • Aucune valeur n'est devinée. C'est l'entreprise qui pose ses hypothèses
//     (« un livrable de ce service reprend 90 minutes ») ; le produit se
//     contente de compter les livrables réels et de multiplier.
//   • Chaque chiffre est ouvrable. Le tableau du bas montre livrable par
//     livrable quelle règle a compté, et ce qui n'est couvert par aucune règle
//     apparaît comme tel au lieu de disparaître.
//   • Le ratio n'est jamais « ∞ ». Sans dépense, il n'est pas calculable, et
//     l'écran l'écrit — afficher un ROI infini le premier jour décrédibilise
//     tout le reste.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CoinsIcon as Coins,
  ClockIcon as Clock,
  TrendUpIcon as TrendingUp,
  WalletIcon as Wallet,
  PlusIcon as Plus,
  TrashIcon as Trash2,
  ScalesIcon as Scale,
  InfoIcon as Info,
  CircleNotchIcon as Loader2,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { KpiGrid, SectionCard, Empty, useHqPalette, type KpiCardDef } from "@/features/dashboard/hq/primitives";
import {
  deleteValueRule, eur, fetchRoi, saveRoiSettings, summariseRoi, upsertValueRule,
  type ValueRule, type ValueRuleScope,
} from "./model";

const RANGES = [
  { key: "30d", label: "30 jours", days: 30 },
  { key: "90d", label: "90 jours", days: 90 },
] as const;

const SCOPE_LABEL: Record<ValueRuleScope, string> = {
  agent: "Un agent",
  service: "Un service",
  deliverable_kind: "Un type de livrable",
  default: "Tout le reste",
};

/** Un réglage numérique qui s'enregistre au blur. Les deux hypothèses de
 *  conversion (taux horaire, prix du crédit) vivent ici et pas dans une page
 *  de paramètres : elles décident des chiffres affichés juste au-dessus, elles
 *  doivent se corriger sans quitter l'écran. */
function RateField({ label, suffix, value, help, onSave }: {
  label: string; suffix: string; value: number; help: string; onSave: (v: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value));
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex items-center gap-1.5">
        <Input
          className="h-8 w-28 text-sm tabular-nums" value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={async () => {
            const n = Number(draft);
            if (!Number.isFinite(n) || n === value) { setDraft(String(value)); return; }
            setBusy(true);
            try { await onSave(n); } finally { setBusy(false); }
          }}
        />
        <span className="text-xs text-muted-foreground">{suffix}</span>
        {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{help}</p>
    </div>
  );
}

export function CompanyRoiPage() {
  const { projectId, workspaceId } = useCurrentContext();
  const qc = useQueryClient();
  const pal = useHqPalette();
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("30d");

  const days = RANGES.find((r) => r.key === range)!.days;
  const sinceIso = useMemo(
    () => new Date(Date.now() - days * 86_400_000).toISOString(),
    [days],
  );

  const { data, isLoading } = useQuery({
    queryKey: ["company_roi", projectId, range],
    enabled: !!projectId,
    queryFn: () => fetchRoi(projectId!, sinceIso),
  });

  const { data: services } = useQuery({
    queryKey: ["company_services", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data: d } = await supabase.from("service_dashboards").select("id, name").eq("project_id", projectId!);
      return (d ?? []) as Array<{ id: string; name: string }>;
    },
  });

  const { data: agents } = useQuery({
    queryKey: ["company_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data: d } = await supabase.from("internal_agents").select("id, name")
        .eq("project_id", projectId!).eq("is_archived", false);
      return (d ?? []) as Array<{ id: string; name: string }>;
    },
  });

  const s = useMemo(() => summariseRoi(data?.events ?? [], data?.spend ?? []), [data]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["company_roi", projectId] });

  // La courbe : valeur produite par jour, cumulée sur la période. Une seule
  // série — deux courbes (valeur et coût) à des ordres de grandeur différents
  // écraseraient la plus petite et ne diraient rien de plus que le ratio.
  const curve = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const e of data?.events ?? []) {
      const d = e.occurred_at.slice(0, 10);
      byDay.set(d, (byDay.get(d) ?? 0) + Number(e.value_eur ?? 0));
    }
    const labels = [...byDay.keys()].sort();
    return {
      name: "Valeur produite",
      data: labels.map((l) => byDay.get(l) ?? 0),
      labels: labels.map((l) => l.slice(5)),
      fullLabels: labels,
      fmt: (v: number) => eur(v),
    };
  }, [data]);

  const cards: KpiCardDef[] = [
    {
      key: "value", label: "Valeur produite", value: eur(s.value),
      sub: `${s.events} livrable${s.events > 1 ? "s" : ""} sur ${days} jours`,
      icon: TrendingUp, accent: pal.slot(0),
      curve: curve.data.length > 1 ? curve : undefined,
    },
    {
      key: "hours", label: "Temps humain repris", value: `${Math.round(s.hours)} h`,
      sub: "d'après vos hypothèses de valorisation",
      icon: Clock, accent: pal.slot(1),
    },
    {
      key: "cost", label: "Dépense IA", value: eur(s.cost),
      sub: `${Math.round(s.credits).toLocaleString("fr-FR")} crédits`,
      icon: Wallet, accent: pal.slot(2),
    },
    {
      key: "ratio", label: "Retour", value: s.ratio == null ? "—" : `${s.ratio.toFixed(1)}×`,
      sub: s.ratio == null ? "aucune dépense sur la période" : `net ${eur(s.net)}`,
      icon: Scale, accent: pal.slot(3),
    },
  ];

  const settings = data?.settings ?? null;
  const rules = data?.rules ?? [];

  const nameForRule = (r: ValueRule) => {
    if (r.scope === "agent") return agents?.find((a) => a.id === r.match_value)?.name ?? "(agent supprimé)";
    if (r.scope === "service") return services?.find((x) => x.id === r.match_value)?.name ?? "(service supprimé)";
    if (r.scope === "deliverable_kind") return r.match_value ?? "—";
    return "tous les livrables non couverts";
  };

  return (
    <div className="space-y-5 px-6 py-6">
      <PageHeader
        title="ROI de la workforce"
        description="Ce que vos agents produisent, en face de ce qu'ils coûtent. Chaque euro affiché se retrace jusqu'au livrable qui l'a produit."
        actions={
          <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.key} onClick={() => setRange(r.key)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs transition-colors",
                  range === r.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      />

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
      ) : (
        <KpiGrid cards={cards} />
      )}

      {s.unpriced > 0 && (
        <Card className="flex items-start gap-2.5 border-amber-500/30 bg-amber-500/5 p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-xs leading-relaxed">
            <span className="font-medium">{s.unpriced} livrable{s.unpriced > 1 ? "s" : ""} ne {s.unpriced > 1 ? "sont" : "est"} couvert{s.unpriced > 1 ? "s" : ""} par aucune règle</span> et compte{s.unpriced > 1 ? "nt" : ""} donc pour zéro.
            La valeur affichée est un plancher, pas une estimation optimiste. Ajoutez une règle ci-dessous pour les valoriser.
          </p>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <SectionCard
          title="Vos hypothèses de valorisation"
          subtitle="La règle la plus précise l'emporte : agent, puis service, puis type, puis le filet."
          icon={<Coins className="h-4 w-4" />}
          right={
            <Button
              size="sm" variant="outline"
              onClick={async () => {
                if (!projectId || !workspaceId) return;
                await upsertValueRule({
                  workspace_id: workspaceId, project_id: projectId,
                  label: "Nouvelle règle", scope: "deliverable_kind", match_value: "report",
                  minutes_saved: 30, revenue_influenced_eur: 0, active: true,
                });
                refresh();
              }}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />Règle
            </Button>
          }
        >
          {rules.length === 0 ? (
            <Empty label="Aucune règle. Sans hypothèse, aucune valeur ne peut être calculée." />
          ) : (
            <div className="space-y-2">
              {rules.map((r) => (
                <div key={r.id} className="group flex flex-wrap items-center gap-2 rounded-lg border border-border/70 p-2.5">
                  <Badge variant="outline" className="shrink-0 text-[10px]">{SCOPE_LABEL[r.scope]}</Badge>
                  <Input
                    className="h-8 min-w-[140px] flex-1 text-sm" defaultValue={r.label}
                    onBlur={async (e) => {
                      if (e.target.value === r.label) return;
                      await upsertValueRule({ ...r, label: e.target.value });
                      refresh();
                    }}
                  />
                  <span className="text-[11px] text-muted-foreground">{nameForRule(r)}</span>
                  <div className="flex items-center gap-1">
                    <Input
                      className="h-8 w-16 text-sm tabular-nums" type="number" defaultValue={r.minutes_saved}
                      onBlur={async (e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v) || v === r.minutes_saved) return;
                        await upsertValueRule({ ...r, minutes_saved: v });
                        refresh();
                      }}
                    />
                    <span className="text-[11px] text-muted-foreground">min repris</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Input
                      className="h-8 w-20 text-sm tabular-nums" type="number" defaultValue={r.revenue_influenced_eur}
                      onBlur={async (e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v) || v === r.revenue_influenced_eur) return;
                        await upsertValueRule({ ...r, revenue_influenced_eur: v });
                        refresh();
                      }}
                    />
                    <span className="text-[11px] text-muted-foreground">€ influencés</span>
                  </div>
                  <Button
                    size="icon" variant="ghost"
                    className="ml-auto h-7 w-7 text-destructive opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={async () => { await deleteValueRule(r.id); refresh(); }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Conversions" subtitle="Deux hypothèses, assumées." icon={<Scale className="h-4 w-4" />}>
          <div className="space-y-4">
            <RateField
              label="Coût horaire humain" suffix="€ / h" value={settings?.default_hourly_rate_eur ?? 45}
              help="Ce que coûte, chargé, la personne qui aurait fait le travail. Sert de défaut à toute règle qui n'en fixe pas un."
              onSave={async (v) => {
                if (!projectId || !workspaceId) return;
                await saveRoiSettings(projectId, workspaceId, { default_hourly_rate_eur: v });
                refresh();
              }}
            />
            <RateField
              label="Prix d'un crédit" suffix="€" value={settings?.credit_price_eur ?? 0.0015}
              help="Ce que vous coûte un crédit. Défaut : le prix catalogue du dépassement. C'est ce qui convertit la consommation en dépense."
              onSave={async (v) => {
                if (!projectId || !workspaceId) return;
                await saveRoiSettings(projectId, workspaceId, { credit_price_eur: v });
                refresh();
              }}
            />
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="D'où vient le chiffre"
        subtitle="Chaque livrable de la période, et la règle qui l'a valorisé."
        icon={<Info className="h-4 w-4" />}
      >
        {(data?.events ?? []).length === 0 ? (
          <Empty label="Aucun livrable produit sur la période." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Livrable</th>
                  <th className="py-2 pr-3 font-medium">Agent</th>
                  <th className="py-2 pr-3 font-medium">Règle appliquée</th>
                  <th className="py-2 pr-3 text-right font-medium">Temps</th>
                  <th className="py-2 text-right font-medium">Valeur</th>
                </tr>
              </thead>
              <tbody>
                {(data?.events ?? []).slice(0, 60).map((e) => (
                  <tr key={e.deliverable_id} className="border-b border-border/50 last:border-0">
                    <td className="max-w-[260px] truncate py-2 pr-3">
                      {e.deliverable_name}
                      <span className="ml-1.5 text-[11px] text-muted-foreground">{e.occurred_at.slice(0, 10)}</span>
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">{e.agent_name ?? "—"}</td>
                    <td className="py-2 pr-3">
                      {e.rule_id
                        ? <span className="text-muted-foreground">{e.rule_label}</span>
                        : <span className="italic text-amber-600 dark:text-amber-400">aucune — compte pour zéro</span>}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                      {e.minutes_saved ? `${e.minutes_saved} min` : "—"}
                    </td>
                    <td className="py-2 text-right font-medium tabular-nums">{eur(Number(e.value_eur ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(data?.events ?? []).length > 60 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                60 premiers livrables affichés sur {(data?.events ?? []).length} — les totaux ci-dessus portent sur l'ensemble.
              </p>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
