import { useMemo, useState } from "react";
import {
  Library,
  Search,
  ChevronRight,
  BarChart3,
  Hash,
  Table as TableIcon,
  List as ListIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MODULE_WIDGETS,
  groupedModuleWidgets,
  type ModuleWidgetEntry,
  type ModuleWidgetKind,
  type ModuleName,
} from "./moduleWidgetRegistry";

const KIND_ICON: Record<ModuleWidgetKind, React.ComponentType<{ className?: string }>> = {
  kpi: Hash,
  chart: BarChart3,
  table: TableIcon,
  list: ListIcon,
};

interface Props {
  /** Called when the user picks a module widget — host adds it to the dashboard. */
  onPick: (widget: ModuleWidgetEntry) => void;
}

/**
 * A module-grouped dropdown library for importing real module widgets into a
 * custom dashboard exactly as they appear in their module (same data + look).
 */
export function WidgetLibraryDropdown({ onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeModule, setActiveModule] = useState<ModuleName | null>(null);

  const grouped = useMemo(() => groupedModuleWidgets(), []);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return MODULE_WIDGETS.filter(
      (w) =>
        w.title.toLowerCase().includes(q) ||
        w.description.toLowerCase().includes(q) ||
        w.module.toLowerCase().includes(q) ||
        w.page.toLowerCase().includes(q),
    );
  }, [search]);

  function pick(w: ModuleWidgetEntry) {
    onPick(w);
    setOpen(false);
    setSearch("");
    setActiveModule(null);
  }

  const visible = activeModule ? grouped.find((g) => g.module === activeModule)?.widgets ?? [] : null;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setSearch("");
          setActiveModule(null);
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" title="Import a widget from a module, as it appears there">
          <Library className="h-4 w-4" /> Module library
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Search across all modules…"
              className="h-8 pl-8 text-xs"
              autoFocus
            />
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-1">
          {searchResults ? (
            searchResults.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                No widget matches “{search}”.
              </p>
            ) : (
              searchResults.map((w) => <WidgetRow key={w.id} widget={w} onPick={pick} showModule />)
            )
          ) : activeModule ? (
            <>
              <button
                type="button"
                onClick={() => setActiveModule(null)}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRight className="h-3.5 w-3.5 rotate-180" /> All modules
              </button>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="uppercase tracking-wide">{activeModule}</DropdownMenuLabel>
              {visible!.map((w) => (
                <WidgetRow key={w.id} widget={w} onPick={pick} />
              ))}
            </>
          ) : (
            grouped.map((g) => (
              <button
                key={g.module}
                type="button"
                onClick={() => setActiveModule(g.module)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <span className="font-medium">{g.module}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {g.widgets.length}
                  <ChevronRight className="h-3.5 w-3.5" />
                </span>
              </button>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WidgetRow({
  widget,
  onPick,
  showModule,
}: {
  widget: ModuleWidgetEntry;
  onPick: (w: ModuleWidgetEntry) => void;
  showModule?: boolean;
}) {
  const Icon = KIND_ICON[widget.kind] ?? Hash;
  return (
    <button
      type="button"
      onClick={() => onPick(widget)}
      className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary text-[hsl(var(--primary-soft))]">
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{widget.title}</span>
          {showModule && (
            <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
              {widget.module}
            </span>
          )}
          <span className="shrink-0 text-[10px] text-muted-foreground">{widget.page}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">{widget.description}</p>
      </div>
    </button>
  );
}
