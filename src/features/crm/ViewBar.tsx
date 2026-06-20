import { useState } from "react";
import { Filter, ArrowUpDown, Plus, X, Trash2, Table2, Columns3, ChevronDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FILTER_OPS, type CrmProperty, type CrmView, type ViewConfig } from "./objectModel";

// View tabs + filter / sort / group controls, shown above the records area.
export function ViewBar({
  views, activeViewId, onSelectView, onAddView, onDeleteView,
  properties, config, onConfigChange,
}: {
  views: CrmView[];
  activeViewId: string | null;
  onSelectView: (id: string) => void;
  onAddView: (kind: CrmView["kind"]) => void;
  onDeleteView: (id: string) => void;
  properties: CrmProperty[];
  config: ViewConfig;
  onConfigChange: (c: ViewConfig) => void;
}) {
  const [menu, setMenu] = useState<null | "filter" | "sort" | "group" | "add">(null);
  const activeView = views.find((v) => v.id === activeViewId);
  const filters = config.filters ?? [];
  const sorts = config.sorts ?? [];
  const selectProps = properties.filter((p) => p.type === "select");

  function patch(p: Partial<ViewConfig>) { onConfigChange({ ...config, ...p }); }

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 text-sm">
      {/* View tabs */}
      <div className="flex items-center gap-0.5">
        {views.map((v) => (
          <button key={v.id} onClick={() => onSelectView(v.id)}
            className={cn("group/v flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors",
              v.id === activeViewId ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50")}>
            {v.kind === "kanban" ? <Columns3 className="h-3.5 w-3.5" /> : <Table2 className="h-3.5 w-3.5" />}
            {v.name}
            {views.length > 1 && (
              <span onClick={(e) => { e.stopPropagation(); if (confirm(`Delete view "${v.name}"?`)) onDeleteView(v.id); }}
                className="hidden rounded p-0.5 hover:text-destructive group-hover/v:inline-flex"><X className="h-3 w-3" /></span>
            )}
          </button>
        ))}
        <Menu open={menu === "add"} onToggle={() => setMenu(menu === "add" ? null : "add")} trigger={<span className="rounded-md px-1.5 py-1.5 text-muted-foreground hover:bg-muted/50"><Plus className="h-3.5 w-3.5" /></span>}>
          <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => { onAddView("table"); setMenu(null); }}><Table2 className="h-3.5 w-3.5" /> Table view</button>
          <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => { onAddView("kanban"); setMenu(null); }}><Columns3 className="h-3.5 w-3.5" /> Kanban view</button>
        </Menu>
      </div>

      <div className="ml-auto flex items-center gap-1">
        {/* Group-by (kanban) */}
        {activeView?.kind === "kanban" && (
          <Menu open={menu === "group"} onToggle={() => setMenu(menu === "group" ? null : "group")}
            trigger={<Pill icon={Columns3} label={config.group_by ? `Group: ${properties.find((p) => p.key === config.group_by)?.label ?? config.group_by}` : "Group by"} active={!!config.group_by} />}>
            {selectProps.length === 0 ? <p className="px-2 py-1.5 text-xs text-muted-foreground">Add a Select property to group by.</p>
              : selectProps.map((p) => (
                <button key={p.id} onClick={() => { patch({ group_by: p.key }); setMenu(null); }} className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-muted">
                  {p.label}{config.group_by === p.key && <Check className="h-3.5 w-3.5 text-primary" />}
                </button>
              ))}
          </Menu>
        )}

        {/* Filter */}
        <Menu open={menu === "filter"} onToggle={() => setMenu(menu === "filter" ? null : "filter")}
          trigger={<Pill icon={Filter} label={filters.length ? `${filters.length} filter${filters.length > 1 ? "s" : ""}` : "Filter"} active={filters.length > 0} />} width="w-80">
          {filters.map((f, i) => (
            <div key={i} className="mb-1 flex items-center gap-1">
              <select value={f.key} onChange={(e) => { const n = [...filters]; n[i] = { ...f, key: e.target.value }; patch({ filters: n }); }} className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-1 text-xs">
                {properties.map((p) => <option key={p.id} value={p.key}>{p.label}</option>)}
              </select>
              <select value={f.op} onChange={(e) => { const n = [...filters]; n[i] = { ...f, op: e.target.value }; patch({ filters: n }); }} className="h-7 rounded border border-input bg-background px-1 text-xs">
                {FILTER_OPS.map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}
              </select>
              {!["is_empty", "is_not_empty"].includes(f.op) && (
                <Input value={String(f.value ?? "")} onChange={(e) => { const n = [...filters]; n[i] = { ...f, value: e.target.value }; patch({ filters: n }); }} className="h-7 w-24" placeholder="value" />
              )}
              <button onClick={() => patch({ filters: filters.filter((_, j) => j !== i) })} className="rounded p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <button onClick={() => patch({ filters: [...filters, { key: properties[0]?.key ?? "name", op: "contains", value: "" }] })} className="mt-1 flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"><Plus className="h-3 w-3" /> Add filter</button>
        </Menu>

        {/* Sort */}
        <Menu open={menu === "sort"} onToggle={() => setMenu(menu === "sort" ? null : "sort")}
          trigger={<Pill icon={ArrowUpDown} label={sorts.length ? `${sorts.length} sort` : "Sort"} active={sorts.length > 0} />} width="w-72">
          {sorts.map((s, i) => (
            <div key={i} className="mb-1 flex items-center gap-1">
              <select value={s.key} onChange={(e) => { const n = [...sorts]; n[i] = { ...s, key: e.target.value }; patch({ sorts: n }); }} className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-1 text-xs">
                {properties.map((p) => <option key={p.id} value={p.key}>{p.label}</option>)}
              </select>
              <select value={s.dir} onChange={(e) => { const n = [...sorts]; n[i] = { ...s, dir: e.target.value as "asc" | "desc" }; patch({ sorts: n }); }} className="h-7 rounded border border-input bg-background px-1 text-xs">
                <option value="asc">Asc</option><option value="desc">Desc</option>
              </select>
              <button onClick={() => patch({ sorts: sorts.filter((_, j) => j !== i) })} className="rounded p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <button onClick={() => patch({ sorts: [...sorts, { key: properties[0]?.key ?? "name", dir: "asc" }] })} className="mt-1 flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"><Plus className="h-3 w-3" /> Add sort</button>
        </Menu>
      </div>
    </div>
  );
}

function Pill({ icon: Icon, label, active }: { icon: typeof Filter; label: string; active?: boolean }) {
  return (
    <span className={cn("flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors", active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/50")}>
      <Icon className="h-3.5 w-3.5" /> {label} <ChevronDown className="h-3 w-3 opacity-60" />
    </span>
  );
}

function Menu({ open, onToggle, trigger, children, width = "w-64" }: { open: boolean; onToggle: () => void; trigger: React.ReactNode; children: React.ReactNode; width?: string }) {
  return (
    <div className="relative">
      <button onClick={onToggle}>{trigger}</button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={onToggle} />
          <div className={cn("absolute right-0 top-full z-20 mt-1 rounded-md border border-border bg-popover p-2 shadow-lg", width)}>{children}</div>
        </>
      )}
    </div>
  );
}
