// Composable agent workspace ("bureau") — differentiation by CONFIGURATION,
// not by per-role pages: internal_agents.workspace_widgets (jsonb string[])
// picks which widgets render from this shared registry. Templates can ship a
// default set; the user can toggle widgets from the customize panel.
import React, { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity, CheckCircle2, Coins, FileText, Lightbulb, Package, Pin,
  Settings2, Target, Loader2, LayoutGrid,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { InternalAgent } from "./shared";

const fmtDate = (s: string) => new Date(s).toLocaleDateString();

// ── Widgets ──────────────────────────────────────────────────────────────────

function KpiOverviewWidget({ agent }: { agent: InternalAgent }) {
  const { data } = useQuery({
    queryKey: ["ws_kpis", agent.id],
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();
      const [{ data: runs }, { count: delivCount }] = await Promise.all([
        supabase.from("internal_agent_runs")
          .select("status, cost_usd, created_at").eq("agent_id", agent.id)
          .gte("created_at", since).order("created_at", { ascending: false }).limit(500),
        supabase.from("internal_agent_deliverables")
          .select("id", { count: "exact", head: true }).eq("agent_id", agent.id),
      ]);
      const all = (runs ?? []) as Array<{ status: string; cost_usd: number | null }>;
      const done = all.filter((r) => r.status === "succeeded").length;
      const finished = all.filter((r) => ["succeeded", "failed"].includes(r.status)).length;
      return {
        runs: all.length,
        successPct: finished ? Math.round((done / finished) * 100) : null,
        cost: all.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0),
        deliverables: delivCount ?? 0,
      };
    },
  });
  const tiles = [
    { label: "Runs (30 j)", value: data ? String(data.runs) : "…", icon: Activity },
    { label: "Taux de succès", value: data ? (data.successPct == null ? "—" : `${data.successPct}%`) : "…", icon: CheckCircle2 },
    { label: "Coût (30 j)", value: data ? `$${data.cost.toFixed(2)}` : "…", icon: Coins },
    { label: "Livrables (total)", value: data ? String(data.deliverables) : "…", icon: Package },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map((t) => (
        <Card key={t.label} className="p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><t.icon className="h-3.5 w-3.5" /> {t.label}</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{t.value}</div>
        </Card>
      ))}
    </div>
  );
}

const COLUMN_META: Record<string, { label: string; cls: string }> = {
  backlog: { label: "Backlog", cls: "text-muted-foreground" },
  todo: { label: "À faire", cls: "text-blue-500" },
  in_progress: { label: "En cours", cls: "text-amber-500" },
  review: { label: "En revue", cls: "text-violet-500" },
  done: { label: "Terminé", cls: "text-emerald-500" },
};
function MissionsMiniWidget({ agent }: { agent: InternalAgent }) {
  const { data: missions } = useQuery({
    queryKey: ["ws_missions", agent.id],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_missions")
        .select("id, title, board_column, status, updated_at")
        .eq("agent_id", agent.id).order("updated_at", { ascending: false }).limit(60);
      return (data ?? []) as Array<{ id: string; title: string; board_column: string | null; status: string; updated_at: string }>;
    },
  });
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of missions ?? []) c[m.board_column ?? "todo"] = (c[m.board_column ?? "todo"] ?? 0) + 1;
    return c;
  }, [missions]);
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Target className="h-3.5 w-3.5" /> Missions</div>
      <div className="mb-3 flex flex-wrap gap-3 text-xs">
        {Object.entries(COLUMN_META).map(([k, meta]) => (
          <span key={k} className={cn("tabular-nums", meta.cls)}>{meta.label} · {counts[k] ?? 0}</span>
        ))}
      </div>
      <div className="space-y-1.5">
        {(missions ?? []).slice(0, 5).map((m) => (
          <div key={m.id} className="flex items-center gap-2 text-sm">
            <span className={cn("shrink-0 text-[10px] uppercase tracking-wide", COLUMN_META[m.board_column ?? "todo"]?.cls ?? "text-muted-foreground")}>
              {COLUMN_META[m.board_column ?? "todo"]?.label ?? m.board_column}
            </span>
            <span className="min-w-0 flex-1 truncate">{m.title}</span>
          </div>
        ))}
        {(missions ?? []).length === 0 && <p className="text-xs text-muted-foreground">Aucune mission pour l'instant.</p>}
      </div>
    </Card>
  );
}

function DeliverablesGalleryWidget({ agent }: { agent: InternalAgent }) {
  const { data: delivs } = useQuery({
    queryKey: ["ws_delivs", agent.id],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_deliverables")
        .select("id, kind, name, summary, created_at")
        .eq("agent_id", agent.id).order("created_at", { ascending: false }).limit(6);
      return (data ?? []) as Array<{ id: string; kind: string; name: string; summary: string | null; created_at: string }>;
    },
  });
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Package className="h-3.5 w-3.5" /> Derniers livrables</div>
      {(delivs ?? []).length === 0 ? (
        <p className="text-xs text-muted-foreground">Aucun livrable pour l'instant.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {(delivs ?? []).map((d) => (
            <div key={d.id} className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
              <div className="flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.name}</span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{d.kind}</span>
              </div>
              {d.summary && <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{d.summary}</p>}
              <div className="mt-1 text-[10px] text-muted-foreground/70">{fmtDate(d.created_at)}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function InitiativesWidget({ agent }: { agent: InternalAgent }) {
  const { data: proposals } = useQuery({
    queryKey: ["ws_initiatives", agent.id],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_missions")
        .select("id, title, brief, created_at, status, board_column")
        .eq("agent_id", agent.id).ilike("brief", "%Proposée par l'agent%")
        .order("created_at", { ascending: false }).limit(8);
      return (data ?? []) as Array<{ id: string; title: string; brief: string | null; created_at: string; status: string; board_column: string | null }>;
    },
  });
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Lightbulb className="h-3.5 w-3.5 text-amber-500" /> Initiatives proposées</div>
      {(proposals ?? []).length === 0 ? (
        <p className="text-xs text-muted-foreground">Rien pour l'instant — l'agent proposera ici les opportunités qu'il repère en travaillant.</p>
      ) : (
        <div className="space-y-2">
          {(proposals ?? []).map((p) => {
            const value = /Valeur attendue\s*:\s*([^\n]+)/.exec(p.brief ?? "")?.[1];
            return (
              <div key={p.id} className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5">
                <div className="flex items-center gap-2 text-sm font-medium">💡 <span className="min-w-0 flex-1 truncate">{p.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{fmtDate(p.created_at)}</span>
                </div>
                {value && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{value}</p>}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function MemoryHighlightsWidget({ agent }: { agent: InternalAgent }) {
  const { data: mems } = useQuery({
    queryKey: ["ws_memories", agent.id],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_memories")
        .select("id, kind, content, importance, is_pinned")
        .eq("agent_id", agent.id)
        .order("is_pinned", { ascending: false }).order("importance", { ascending: false })
        .order("updated_at", { ascending: false }).limit(6);
      return (data ?? []) as Array<{ id: string; kind: string; content: string; importance: number; is_pinned: boolean }>;
    },
  });
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Pin className="h-3.5 w-3.5" /> Mémoire clé</div>
      {(mems ?? []).length === 0 ? (
        <p className="text-xs text-muted-foreground">Aucune mémoire pour l'instant.</p>
      ) : (
        <ul className="space-y-1.5">
          {(mems ?? []).map((m) => (
            <li key={m.id} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{m.kind}{m.is_pinned ? " · 📌" : ""}</span>
              <span className="min-w-0 flex-1 text-muted-foreground">{m.content}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Registry + tab ───────────────────────────────────────────────────────────
const WIDGETS: Record<string, { label: string; Component: (p: { agent: InternalAgent }) => React.ReactElement }> = {
  kpi_overview: { label: "KPIs de l'agent", Component: KpiOverviewWidget },
  missions_mini: { label: "Missions (aperçu)", Component: MissionsMiniWidget },
  deliverables_gallery: { label: "Derniers livrables", Component: DeliverablesGalleryWidget },
  initiatives: { label: "Initiatives proposées", Component: InitiativesWidget },
  memory_highlights: { label: "Mémoire clé", Component: MemoryHighlightsWidget },
};
export const DEFAULT_WORKSPACE = ["kpi_overview", "missions_mini", "deliverables_gallery", "initiatives"];

export function WorkspaceTab({ agent }: { agent: InternalAgent }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const active: string[] = Array.isArray((agent as { workspace_widgets?: unknown }).workspace_widgets)
    ? ((agent as { workspace_widgets?: string[] }).workspace_widgets as string[]).filter((w) => WIDGETS[w])
    : DEFAULT_WORKSPACE;

  async function toggle(id: string) {
    const next = active.includes(id) ? active.filter((w) => w !== id) : [...active, id];
    setSaving(true);
    try {
      await supabase.from("internal_agents").update({ workspace_widgets: next }).eq("id", agent.id);
      queryClient.invalidateQueries({ queryKey: ["internal_agent", agent.id] });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <LayoutGrid className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Workspace</h2>
        <span className="text-[11px] text-muted-foreground">le bureau de {agent.name}</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing(!editing)}>
          {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Settings2 className="mr-1 h-3.5 w-3.5" />} Personnaliser
        </Button>
      </div>

      {editing && (
        <Card className="flex flex-wrap items-center gap-2 p-3">
          {Object.entries(WIDGETS).map(([id, w]) => (
            <button
              key={id}
              onClick={() => toggle(id)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                active.includes(id)
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {w.label}
            </button>
          ))}
        </Card>
      )}

      {active.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">Aucun widget — cliquez « Personnaliser » pour composer le bureau de cet agent.</Card>
      ) : (
        <div className="space-y-3">
          {active.map((id) => {
            const W = WIDGETS[id];
            return W ? <W.Component key={id} agent={agent} /> : null;
          })}
        </div>
      )}
    </div>
  );
}
