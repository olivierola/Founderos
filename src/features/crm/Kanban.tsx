import { useMemo, useState } from "react";
import { Columns3, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/EmptyState";
import type { CrmObject, CrmProperty, CrmRecord, SelectOption } from "./objectModel";

// Kanban: one column per option of the group-by select property, drag cards
// between columns to set that property's value.
export function Kanban({
  object, properties, records, groupByKey, onMove, onOpen,
}: {
  object: CrmObject;
  properties: CrmProperty[];
  records: CrmRecord[];
  groupByKey: string | undefined;
  onMove: (record: CrmRecord, value: string | null) => void;
  onOpen: (record: CrmRecord) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const groupProp = properties.find((p) => p.key === groupByKey);
  const titleKey = properties.find((p) => p.is_title)?.key ?? "name";
  const visibleProps = properties.filter((p) => !p.is_title && p.key !== groupByKey).slice(0, 4);

  const columns = useMemo(() => {
    const opts: (SelectOption | { value: null; label: string; color?: string })[] = [
      ...(groupProp?.options ?? []),
      { value: null, label: "No " + (groupProp?.label ?? "value") },
    ];
    return opts.map((o) => ({
      ...o,
      records: records.filter((r) => (r.data[groupByKey ?? ""] ?? null) === o.value),
    }));
  }, [records, groupProp, groupByKey]);

  if (!groupProp) {
    return <EmptyState icon={Columns3} title="Pick a property to group by" description="Use “Group by” above to choose a Select property for the kanban columns." />;
  }

  return (
    <div className="flex h-full gap-3 overflow-x-auto p-3">
      {columns.map((col) => (
        <div
          key={String(col.value)}
          onDragOver={(e) => { e.preventDefault(); setOver(String(col.value)); }}
          onDragLeave={() => setOver((p) => (p === String(col.value) ? null : p))}
          onDrop={() => { if (dragId) { const rec = records.find((r) => r.id === dragId); if (rec) onMove(rec, col.value); } setDragId(null); setOver(null); }}
          className={cn("flex w-72 shrink-0 flex-col rounded-lg border bg-muted/20 transition-colors", over === String(col.value) ? "border-primary" : "border-border")}
        >
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="h-2 w-2 rounded-full" style={{ background: ("color" in col && col.color) || "#64748b" }} />
            <span className="text-sm font-medium">{col.label}</span>
            <span className="ml-auto rounded bg-muted px-1.5 text-xs text-muted-foreground">{col.records.length}</span>
          </div>
          <div className="min-h-[60px] flex-1 space-y-2 overflow-y-auto p-2">
            {col.records.map((r) => (
              <div key={r.id} draggable onDragStart={() => setDragId(r.id)} onDragEnd={() => { setDragId(null); setOver(null); }}
                onClick={() => onOpen(r)}
                className={cn("group/c cursor-grab rounded-md border border-border bg-card p-2.5 active:cursor-grabbing hover:border-primary/40", dragId === r.id && "opacity-50")}>
                <div className="flex items-start justify-between gap-1">
                  <span className="truncate text-sm font-medium">{String(r.data[titleKey] ?? "Untitled")}</span>
                  <button onClick={(e) => { e.stopPropagation(); onOpen(r); }} className="opacity-0 group-hover/c:opacity-100"><Maximize2 className="h-3 w-3 text-muted-foreground" /></button>
                </div>
                <div className="mt-1 space-y-0.5">
                  {visibleProps.map((p) => {
                    const v = r.data[p.key];
                    if (v == null || v === "") return null;
                    return <div key={p.id} className="truncate text-[11px] text-muted-foreground"><span className="opacity-60">{p.label}:</span> {renderMini(p, v)}</div>;
                  })}
                </div>
              </div>
            ))}
            {col.records.length === 0 && <div className="rounded-md border border-dashed border-border/60 py-3 text-center text-[11px] text-muted-foreground">Drop here</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function renderMini(p: CrmProperty, v: unknown): string {
  if (p.type === "select") return p.options.find((o) => o.value === v)?.label ?? String(v);
  if (p.type === "currency") return new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(Number(v));
  if (p.type === "checkbox") return v ? "✓" : "—";
  return String(v);
}
