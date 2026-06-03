import { useMemo, useState } from "react";
import { Search, Plus, BarChart3, LineChart, PieChart, Hash, Table as TableIcon, FileText, LayoutGrid } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { WIDGET_CATALOG, getCatalogCategories, type CatalogWidget } from "./widgetCatalog";
import type { WidgetType } from "./types";

const TYPE_ICON: Record<WidgetType, React.ComponentType<{ className?: string }>> = {
  kpi: Hash,
  line: LineChart,
  bar: BarChart3,
  area: LineChart,
  pie: PieChart,
  table: TableIcon,
  markdown: FileText,
  module: LayoutGrid,
};

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Called when the user picks a widget — host should add it to the dashboard. */
  onPick: (widget: CatalogWidget) => void;
}

export function WidgetCatalogDialog({ open, onOpenChange, onPick }: Props) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("All");

  const categories = useMemo(() => ["All", ...getCatalogCategories()], []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return WIDGET_CATALOG.filter((w) => {
      if (activeCategory !== "All" && w.category !== activeCategory) return false;
      if (!q) return true;
      return (
        w.title.toLowerCase().includes(q) ||
        w.description.toLowerCase().includes(q) ||
        w.category.toLowerCase().includes(q) ||
        (w.keywords ?? []).some((k) => k.includes(q))
      );
    });
  }, [search, activeCategory]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-6 pb-4 pt-5">
          <DialogTitle>Widget catalog</DialogTitle>
          <DialogDescription>
            Pick a pre-configured widget from any module — it lands fully editable in your dashboard.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col">
          {/* Search + categories */}
          <div className="space-y-3 border-b border-border px-6 py-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search MRR, churn, errors, scans…"
                className="pl-8"
                autoFocus
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setActiveCategory(c)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    activeCategory === c
                      ? "border-[hsl(var(--primary-soft)/0.4)] bg-[hsl(var(--primary-soft)/0.12)] text-[hsl(var(--primary-soft))]"
                      : "border-border text-muted-foreground hover:bg-secondary",
                  )}
                >
                  {c}
                  {c !== "All" && (
                    <span className="ml-1 text-[10px] opacity-60">
                      {WIDGET_CATALOG.filter((w) => w.category === c).length}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Catalog grid */}
          <div className="max-h-[55vh] overflow-y-auto px-6 py-4">
            {filtered.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No widget matches “{search}”.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {filtered.map((w) => {
                  const Icon = TYPE_ICON[w.type] ?? Hash;
                  return (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => {
                        onPick(w);
                        onOpenChange(false);
                      }}
                      className="group flex items-start gap-3 rounded-md border border-border p-3 text-left transition-colors hover:border-[hsl(var(--primary-soft)/0.4)] hover:bg-secondary/40"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-[hsl(var(--primary-soft))]">
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{w.title}</span>
                          <Badge variant="outline" className="shrink-0 text-[10px]">
                            {w.category}
                          </Badge>
                          <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
                            {w.type}
                          </Badge>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {w.description}
                        </p>
                      </div>
                      <Plus className="mt-1 h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
