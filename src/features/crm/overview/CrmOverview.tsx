import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Responsive, WidthProvider, type Layout } from "react-grid-layout";
import {
  CalendarDays, GripVertical, LayoutGrid, Loader2, Eye, RotateCcw, Check,
  GripHorizontal, BarChart3, LineChart as LineChartIcon, AreaChart,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExportMenu } from "@/components/ExportMenu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { fetchObjects, fetchProperties, type CrmProperty } from "../objectModel";
import { WaffleTrend } from "./WaffleTrend";
import { SeriesChart } from "./SeriesChart";
import { KpiRow, PropertyBreakdown, ObjectsBreakdown } from "./OverviewCards";
import {
  fetchOverviewRecords, makeBuckets, previousBuckets, seriesFor, totalFor, deltaPct,
  distributionFor, observableProperties, objectStats, METRICS, RANGES,
  type MetricKey, type RangeKey,
} from "./crmStats";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

const ResponsiveGrid = WidthProvider(Responsive);

// ── trend chart variants ────────────────────────────────────────────────────
type ChartVariant = "waffle" | "bars" | "line" | "area";

const CHART_VARIANTS: { key: ChartVariant; label: string; icon: typeof BarChart3 }[] = [
  { key: "waffle", label: "Cases", icon: GripHorizontal },
  { key: "bars", label: "Barres", icon: BarChart3 },
  { key: "line", label: "Courbe", icon: LineChartIcon },
  { key: "area", label: "Aire", icon: AreaChart },
];

// ── modular cards ───────────────────────────────────────────────────────────
type CardId = "trend" | "breakdown" | "objects";

const CARD_META: Record<CardId, string> = {
  trend: "Tendance",
  breakdown: "Répartition par propriété",
  objects: "Objets & volumes",
};

const COLS = 12;

const DEFAULT_LAYOUT: Layout[] = [
  { i: "trend", x: 0, y: 0, w: 12, h: 6, minW: 6, minH: 5 },
  { i: "breakdown", x: 0, y: 6, w: 6, h: 5, minW: 4, minH: 4 },
  { i: "objects", x: 6, y: 6, w: 6, h: 5, minW: 4, minH: 4 },
];

const ROW_H = 72;

// Bump the version to invalidate any degenerate layout saved by an earlier build
// (e.g. cards squashed to a couple of columns).
function layoutKey(projectId: string | null) {
  return `founderos.crmOverview.v2.${projectId ?? "none"}`;
}

interface Persisted {
  layout: Layout[];
  hidden: CardId[];
  chart?: ChartVariant;
}

/**
 * Rebuilds the layout off DEFAULT_LAYOUT, keeping only sane saved geometry. A
 * stale or clamped entry (e.g. a width saved while the grid was measured at 0px
 * and every card got squashed to 1 column) otherwise sticks forever.
 */
function normalizeLayout(saved: unknown): Layout[] {
  const arr = Array.isArray(saved) ? (saved as Layout[]) : [];
  return DEFAULT_LAYOUT.map((d) => {
    const s = arr.find((x) => x && x.i === d.i);
    if (!s) return { ...d };
    const w = Math.min(COLS, Math.max(d.minW ?? 1, Math.round(Number(s.w)) || d.w));
    const h = Math.max(d.minH ?? 1, Math.round(Number(s.h)) || d.h);
    const x = Math.min(COLS - w, Math.max(0, Math.round(Number(s.x)) || 0));
    const y = Math.max(0, Math.round(Number(s.y)) || 0);
    return { ...d, x, y, w, h };
  });
}

function loadPersisted(projectId: string | null): Persisted {
  try {
    const raw = localStorage.getItem(layoutKey(projectId));
    if (raw) {
      const p = JSON.parse(raw) as Persisted;
      return {
        layout: normalizeLayout(p.layout),
        hidden: Array.isArray(p.hidden) ? p.hidden : [],
        chart: p.chart,
      };
    }
  } catch { /* ignore */ }
  return { layout: DEFAULT_LAYOUT, hidden: [], chart: "waffle" };
}

export function CrmOverviewPage() {
  const { projectId, loading } = useCurrentContext();

  // ── one filter row scopes every card ──
  const [range, setRange] = useState<RangeKey>("12m");
  const [compare, setCompare] = useState(true);
  const [objectId, setObjectId] = useState<string | null>(null);
  const [propKey, setPropKey] = useState<string | null>(null);
  const [metric, setMetric] = useState<MetricKey>("created");

  // ── modular card state ──
  const [organise, setOrganise] = useState(false);
  const [persisted, setPersisted] = useState<Persisted>(() => loadPersisted(null));

  useEffect(() => {
    setPersisted(loadPersisted(projectId));
  }, [projectId]);

  function persist(next: Persisted) {
    setPersisted(next);
    try { localStorage.setItem(layoutKey(projectId), JSON.stringify(next)); } catch { /* ignore */ }
  }

  const { data: objects } = useQuery({
    queryKey: ["crm_objects", projectId],
    enabled: !!projectId,
    queryFn: () => fetchObjects(projectId!),
  });

  const { data: records, isLoading: loadingRecords, isFetching } = useQuery({
    queryKey: ["crm_overview_records", projectId],
    enabled: !!projectId,
    queryFn: () => fetchOverviewRecords(projectId!),
  });

  // Default to the first object once loaded.
  useEffect(() => {
    if (!objectId && objects && objects.length > 0) setObjectId(objects[0].id);
  }, [objects, objectId]);

  const { data: properties } = useQuery({
    queryKey: ["crm_properties", objectId],
    enabled: !!objectId,
    queryFn: () => fetchProperties(objectId!),
  });

  const observable = useMemo(() => observableProperties(properties ?? []), [properties]);

  // Default the observed property to the most informative one. The title
  // property (usually "Name") is a poor default: every record has one, so its
  // breakdown is just "Renseigné: 100%".
  useEffect(() => {
    if (observable.length === 0) { setPropKey(null); return; }
    if (propKey && observable.some((p) => p.key === propKey)) return;
    const byType = (t: CrmProperty["type"]) => observable.find((p) => p.type === t && !p.is_title);
    const pick =
      byType("select") ?? byType("multi_select") ?? byType("checkbox") ?? byType("rating") ??
      observable.find((p) => !p.is_title) ?? observable[0];
    setPropKey(pick.key);
  }, [observable, propKey]);

  const activeObject = objects?.find((o) => o.id === objectId) ?? null;
  const property: CrmProperty | null = observable.find((p) => p.key === propKey) ?? null;

  // ── derive every series from the one records fetch ──
  const buckets = useMemo(() => makeBuckets(range), [range]);
  const prevB = useMemo(() => previousBuckets(buckets), [buckets]);

  const scoped = useMemo(
    () => (records ?? []).filter((r) => (objectId ? r.object_id === objectId : true)),
    [records, objectId],
  );

  const curSeries = useMemo(() => seriesFor(metric, scoped, buckets, propKey), [metric, scoped, buckets, propKey]);
  const prevSeries = useMemo(
    () => (compare ? seriesFor(metric, scoped, prevB, propKey) : null),
    [compare, metric, scoped, prevB, propKey],
  );

  const tiles = useMemo(
    () =>
      METRICS.map((def) => {
        const c = totalFor(def.key, seriesFor(def.key, scoped, buckets, propKey));
        const p = totalFor(def.key, seriesFor(def.key, scoped, prevB, propKey));
        return { def, value: c, delta: deltaPct(c, p) };
      }),
    [scoped, buckets, prevB, propKey],
  );

  // The breakdown reflects the records created inside the window.
  const windowed = useMemo(() => {
    if (buckets.length === 0) return scoped;
    const from = buckets[0].start;
    const to = buckets[buckets.length - 1].end;
    return scoped.filter((r) => {
      const t = +new Date(r.created_at);
      return t >= from && t < to;
    });
  }, [scoped, buckets]);

  const dist = useMemo(() => distributionFor(windowed, property), [windowed, property]);
  const oStats = useMemo(() => objectStats(objects ?? [], records ?? [], buckets), [objects, records, buckets]);

  const visible = useMemo(
    () => (Object.keys(CARD_META) as CardId[]).filter((c) => !persisted.hidden.includes(c)),
    [persisted.hidden],
  );
  // Stable identity: a fresh layouts object every render makes RGL re-init.
  const layouts = useMemo(() => {
    const l = persisted.layout.filter((x) => visible.includes(x.i as CardId));
    return { lg: l, md: l, sm: l, xs: l, xxs: l };
  }, [persisted.layout, visible]);

  const activeMetric = METRICS.find((m) => m.key === metric)!;
  const chart: ChartVariant = persisted.chart ?? "waffle";

  const exportRows = useMemo(
    () =>
      buckets.map((b, i) => ({
        periode: b.full,
        objet: activeObject?.label ?? "Tous",
        metrique: activeMetric.label,
        valeur: curSeries[i] ?? 0,
        precedent: prevSeries ? prevSeries[i] ?? 0 : "",
      })),
    [buckets, curSeries, prevSeries, activeObject, activeMetric],
  );

  if (loading || loadingRecords) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const cardBody: Record<CardId, ReactElement> = {
    trend: (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-2 pt-4">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-foreground">
              Tendance · {activeObject?.label_plural || activeObject?.label || "Tous les objets"}
            </h3>
            {/* Say exactly what is plotted — the tile row is the metric selector. */}
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{activeMetric.hint}</p>
          </div>
          <ChartVariantToggle
            value={chart}
            onChange={(v) => persist({ ...persisted, chart: v })}
          />
        </div>
        {/* min-h-0 + flex-1: the chart measures THIS box and fits itself to it. */}
        <div className="min-h-0 flex-1 px-5 pb-2">
          {chart === "waffle" ? (
            <WaffleTrend
              buckets={buckets}
              current={curSeries}
              previous={prevSeries}
              suffix={activeMetric.unit ?? ""}
            />
          ) : (
            <SeriesChart
              variant={chart}
              buckets={buckets}
              current={curSeries}
              previous={prevSeries}
              suffix={activeMetric.unit ?? ""}
            />
          )}
        </div>
        <div className="shrink-0">
          <KpiRow tiles={tiles} active={metric} onSelect={setMetric} />
        </div>
      </div>
    ),
    breakdown: (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="px-5 pb-3 pt-4">
          <h3 className="text-sm font-semibold text-foreground">Répartition</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {property ? `Par ${property.label}` : "Choisissez une propriété"} · sur la période
          </p>
        </div>
        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          <PropertyBreakdown property={property} items={dist} total={windowed.length} />
        </div>
      </div>
    ),
    objects: (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="px-5 pb-3 pt-4">
          <h3 className="text-sm font-semibold text-foreground">Objets</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Volume total · évolution sur la période</p>
        </div>
        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <ObjectsBreakdown stats={oStats} activeObjectId={objectId} onSelect={setObjectId} />
        </div>
      </div>
    ),
  };

  return (
    <div>
      {/* ── ONE filter row, above everything it scopes ── */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Picker
          icon={<CalendarDays className="h-3.5 w-3.5" />}
          label={RANGES.find((r) => r.key === range)!.label}
          items={RANGES.map((r) => ({ key: r.key, label: r.label }))}
          active={range}
          onSelect={(k) => setRange(k as RangeKey)}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCompare((v) => !v)}
          className={cn("h-9", compare && "border-foreground/25")}
        >
          {compare && <Check className="h-3.5 w-3.5" />} Comparer à la période précédente
        </Button>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Picker
            icon={activeObject ? undefined : <LayoutGrid className="h-3.5 w-3.5" />}
            label={activeObject?.label_plural || activeObject?.label || "Objet"}
            items={(objects ?? []).map((o) => ({ key: o.id, label: o.label_plural || o.label }))}
            active={objectId ?? ""}
            onSelect={setObjectId}
          />
          <Picker
            icon={<Eye className="h-3.5 w-3.5" />}
            label={property ? `Observer : ${property.label}` : "Observer"}
            items={observable.map((p) => ({ key: p.key, label: p.label }))}
            active={propKey ?? ""}
            onSelect={setPropKey}
          />
          <ExportMenu rows={exportRows} filename={`crm-overview-${range}`} />
          <Button
            variant={organise ? "default" : "outline"}
            size="sm"
            className="h-9"
            onClick={() => setOrganise((v) => !v)}
          >
            <GripVertical className="h-3.5 w-3.5" /> {organise ? "Terminer" : "Organiser"}
          </Button>
          {organise && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9">Cartes</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Afficher</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {(Object.keys(CARD_META) as CardId[]).map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c}
                      checked={!persisted.hidden.includes(c)}
                      onCheckedChange={(on) =>
                        persist({
                          ...persisted,
                          hidden: on ? persisted.hidden.filter((h) => h !== c) : [...persisted.hidden, c],
                        })
                      }
                    >
                      {CARD_META[c]}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={() => persist({ layout: DEFAULT_LAYOUT, hidden: [] })}
                title="Réinitialiser la disposition"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Hold the previous render at reduced opacity on refetch — no skeleton flash. */}
      <div className={cn("transition-opacity", isFetching && "opacity-60")}>
        <ResponsiveGrid
          className="layout"
          layouts={layouts}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
          cols={{ lg: COLS, md: COLS, sm: 6, xs: 4, xxs: 2 }}
          rowHeight={ROW_H}
          margin={[16, 16]}
          isDraggable={organise}
          isResizable={organise}
          draggableHandle=".drag-handle"
          onLayoutChange={(l) => organise && persist({ ...persisted, layout: l })}
        >
          {visible.map((id) => (
            <div key={id}>
              <Card className={cn("relative h-full overflow-hidden", organise && "ring-1 ring-primary/30")}>
                {organise && (
                  <div className="drag-handle absolute right-2 top-2 z-10 flex cursor-move items-center gap-1 rounded-md bg-secondary px-1.5 py-1 text-[10px] text-muted-foreground">
                    <GripVertical className="h-3 w-3" /> {CARD_META[id]}
                  </div>
                )}
                {cardBody[id]}
              </Card>
            </div>
          ))}
        </ResponsiveGrid>
      </div>
    </div>
  );
}

/** Small dropdown used by the filter row. */
/** Segmented control switching the trend card between waffle / bars / line / area. */
function ChartVariantToggle({ value, onChange }: { value: ChartVariant; onChange: (v: ChartVariant) => void }) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
        {CHART_VARIANTS.map((v) => {
          const Icon = v.icon;
          const active = v.key === value;
          return (
            <Tooltip key={v.key}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onChange(v.key)}
                  aria-pressed={active}
                  aria-label={v.label}
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                    active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{v.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

function Picker({
  icon, label, items, active, onSelect,
}: {
  icon?: ReactNode;
  label: string;
  items: { key: string; label: string }[];
  active: string;
  onSelect: (k: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 max-w-[240px]">
          {icon}
          <span className="truncate">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {items.length === 0 && <DropdownMenuItem disabled>Aucun</DropdownMenuItem>}
        {items.map((it) => (
          <DropdownMenuItem key={it.key} onSelect={() => onSelect(it.key)}>
            <span className={cn("flex-1", it.key === active && "font-medium")}>{it.label}</span>
            {it.key === active && <Check className="h-3.5 w-3.5 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
