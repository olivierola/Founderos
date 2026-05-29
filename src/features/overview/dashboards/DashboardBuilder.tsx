import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import GridLayout from "react-grid-layout";

interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}
import { ArrowLeft, Plus, Loader2, Pencil, Trash2, Save, GripVertical, MoreVertical, RefreshCw, X, FileDown } from "lucide-react";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { WidgetView, type CrossFilter } from "./WidgetView";
import { WidgetConfigDialog } from "./WidgetConfigDialog";
import { exportDashboardPdf } from "./exportPdf";
import type { Widget, WidgetConfig, WidgetType } from "./types";

const COLS = 12;
const ROW_H = 80;

const DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  kpi: { w: 3, h: 2 },
  line: { w: 6, h: 4 },
  bar: { w: 6, h: 4 },
  area: { w: 6, h: 4 },
  pie: { w: 4, h: 4 },
  table: { w: 6, h: 5 },
  markdown: { w: 4, h: 2 },
};

export function DashboardBuilderPage() {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug, dashboardId } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();

  const [editMode, setEditMode] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [editingWidget, setEditingWidget] = useState<Widget | null>(null);
  const [dirtyLayout, setDirtyLayout] = useState<GridItem[] | null>(null);
  const [savingLayout, setSavingLayout] = useState(false);
  const [crossFilter, setCrossFilter] = useState<CrossFilter | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(0); // seconds, 0 = off
  const [exporting, setExporting] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  async function handleExportPdf() {
    if (!gridRef.current) return;
    setExporting(true);
    try {
      await exportDashboardPdf(gridRef.current, dashQuery.data?.name ?? "dashboard");
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => setRefreshKey((k) => k + 1), autoRefresh * 1000);
    return () => clearInterval(id);
  }, [autoRefresh]);

  const dashQuery = useQuery({
    queryKey: ["dashboard", dashboardId],
    enabled: !!dashboardId,
    queryFn: async () => {
      const { data } = await supabase.from("custom_dashboards").select("*").eq("id", dashboardId!).maybeSingle();
      return data;
    },
  });

  const widgetsQuery = useQuery({
    queryKey: ["dashboard-widgets", dashboardId],
    enabled: !!dashboardId,
    queryFn: async () => {
      const { data } = await supabase
        .from("dashboard_widgets")
        .select("*")
        .eq("dashboard_id", dashboardId!)
        .order("created_at", { ascending: true });
      return (data ?? []) as Widget[];
    },
  });

  const widgets = widgetsQuery.data ?? [];

  const layout: GridItem[] = useMemo(
    () =>
      widgets.map((w, i) => ({
        i: w.id,
        x: w.position?.x ?? (i * 3) % COLS,
        y: w.position?.y ?? Math.floor(i / 4) * 2,
        w: w.position?.w ?? DEFAULT_SIZE[w.type].w,
        h: w.position?.h ?? DEFAULT_SIZE[w.type].h,
        minW: 2,
        minH: 2,
      })),
    [widgets],
  );

  async function saveWidget(data: { type: WidgetType; title: string; config: WidgetConfig }) {
    if (!workspaceId || !dashboardId) return;
    if (editingWidget) {
      await supabase
        .from("dashboard_widgets")
        .update({ type: data.type, title: data.title, config: data.config })
        .eq("id", editingWidget.id);
    } else {
      const size = DEFAULT_SIZE[data.type];
      await supabase.from("dashboard_widgets").insert({
        dashboard_id: dashboardId,
        workspace_id: workspaceId,
        type: data.type,
        title: data.title,
        config: data.config,
        position: { x: 0, y: 0, w: size.w, h: size.h },
      });
    }
    setEditingWidget(null);
    queryClient.invalidateQueries({ queryKey: ["dashboard-widgets", dashboardId] });
  }

  async function deleteWidget(id: string) {
    await supabase.from("dashboard_widgets").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["dashboard-widgets", dashboardId] });
  }

  async function saveLayout() {
    if (!dirtyLayout) {
      setEditMode(false);
      return;
    }
    setSavingLayout(true);
    try {
      await Promise.all(
        dirtyLayout.map((l) =>
          supabase
            .from("dashboard_widgets")
            .update({ position: { x: l.x, y: l.y, w: l.w, h: l.h } })
            .eq("id", l.i),
        ),
      );
      setDirtyLayout(null);
      setEditMode(false);
      queryClient.invalidateQueries({ queryKey: ["dashboard-widgets", dashboardId] });
    } finally {
      setSavingLayout(false);
    }
  }

  if (!workspaceId || !projectId || dashQuery.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/overview/custom-dashboards`)}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{dashQuery.data?.name ?? "Dashboard"}</h1>
            {dashQuery.data?.description && (
              <p className="text-sm text-muted-foreground">{dashQuery.data.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={autoRefresh}
            onChange={(e) => setAutoRefresh(Number(e.target.value))}
            className="h-9 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground"
            title="Auto-refresh interval"
          >
            <option value={0}>Manual</option>
            <option value={15}>Every 15s</option>
            <option value={30}>Every 30s</option>
            <option value={60}>Every 1m</option>
            <option value={300}>Every 5m</option>
          </select>
          <Button variant="outline" size="sm" onClick={() => setRefreshKey((k) => k + 1)} title="Refresh data">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportPdf} disabled={exporting || widgets.length === 0} title="Export to PDF">
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />} PDF
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setEditingWidget(null); setConfigOpen(true); }}>
            <Plus className="h-4 w-4" /> Add widget
          </Button>
          {editMode ? (
            <Button size="sm" onClick={saveLayout} disabled={savingLayout}>
              {savingLayout ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save layout
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setEditMode(true)}>
              <GripVertical className="h-4 w-4" /> Arrange
            </Button>
          )}
        </div>
      </div>

      {crossFilter && (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Filtered by</span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/15 px-2.5 py-1 text-xs text-primary">
            <span className="font-mono">{crossFilter.column}</span>
            <span className="opacity-70">=</span>
            <span className="font-medium">{crossFilter.value}</span>
            <button onClick={() => setCrossFilter(null)} className="ml-0.5 rounded-full hover:bg-primary/20">
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      )}

      {widgetsQuery.isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : widgets.length === 0 ? (
        <EmptyState
          icon={Plus}
          title="Empty dashboard"
          description="Add KPI cards, charts, tables or notes. Drag to arrange, resize from the corner."
          action={
            <Button onClick={() => { setEditingWidget(null); setConfigOpen(true); }}>
              <Plus className="h-4 w-4" /> Add your first widget
            </Button>
          }
        />
      ) : (
        <div ref={gridRef}>
        <GridLayout
          className="layout"
          layout={layout as never}
          cols={COLS}
          rowHeight={ROW_H}
          width={1100}
          isDraggable={editMode}
          isResizable={editMode}
          onLayoutChange={((l: GridItem[]) => editMode && setDirtyLayout([...l])) as never}
          draggableHandle=".drag-handle"
        >
          {widgets.map((w) => (
            <div key={w.id}>
              <Card className="flex h-full flex-col overflow-hidden">
                <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {editMode && <GripVertical className="drag-handle h-3.5 w-3.5 shrink-0 cursor-move text-muted-foreground" />}
                    <span className="truncate text-xs font-medium">{w.title || w.type}</span>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-6 w-6">
                        <MoreVertical className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => { setEditingWidget(w); setConfigOpen(true); }}>
                        <Pencil className="h-4 w-4" /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem destructive onClick={() => deleteWidget(w.id)}>
                        <Trash2 className="h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <CardContent className="min-h-0 flex-1 p-3">
                  <WidgetView
                    widget={w}
                    workspaceId={workspaceId}
                    projectId={projectId}
                    crossFilter={crossFilter}
                    refreshKey={refreshKey}
                    onSegmentClick={setCrossFilter}
                  />
                </CardContent>
              </Card>
            </div>
          ))}
        </GridLayout>
        </div>
      )}

      <WidgetConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        widget={editingWidget}
        onSave={saveWidget}
      />
    </div>
  );
}
