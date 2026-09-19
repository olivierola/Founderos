import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowsClockwiseIcon, FileTextIcon, MagnifyingGlassIcon, SquaresFourIcon, StackIcon,
} from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { searchTracker, type SearchHit } from "./model";
import { TextField } from "./ui";

/**
 * La recherche transverse du dashboard : work items, cycles, modules, pages.
 *
 * Elle passe par une fonction SQL (0222) et non par quatre requêtes côté
 * client, parce que le classement doit être GLOBAL. Quatre listes triées
 * chacune de son côté remonteraient un cycle vaguement pertinent au-dessus du
 * work item qu'on cherchait vraiment.
 */
const ICONS = {
  issue: SquaresFourIcon,
  cycle: ArrowsClockwiseIcon,
  module: StackIcon,
  page: FileTextIcon,
} as const;

const KIND_LABEL = {
  issue: "Work item", cycle: "Cycle", module: "Module", page: "Page",
} as const;

export function TrackerSearch({
  dashboardId, onPick,
}: { dashboardId: string; onPick?: (hit: SearchHit) => void }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [query, setQuery] = useState("");

  // On interroge la base 250 ms après la dernière frappe : une requête par
  // caractère saturerait le serveur pour des résultats que personne ne lit,
  // puisqu'ils sont remplacés à la lettre suivante.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(raw), 250);
    return () => clearTimeout(timer);
  }, [raw]);

  const { data: hits, isFetching } = useQuery({
    queryKey: ["pj_search", dashboardId, query],
    enabled: query.trim().length >= 2,
    queryFn: () => searchTracker(dashboardId, query),
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Rechercher"
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <MagnifyingGlassIcon className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="border-b border-border p-2">
          <TextField
            autoFocus value={raw} onChange={(e) => setRaw(e.target.value)}
            placeholder="Rechercher dans le service…" className="h-8 text-14"
          />
        </div>
        <div className="max-h-[360px] overflow-y-auto">
          {query.trim().length < 2 ? (
            <p className="px-3 py-6 text-center text-12 text-muted-foreground">
              Saisissez au moins deux caractères.
            </p>
          ) : isFetching ? (
            <p className="px-3 py-6 text-center text-12 text-muted-foreground">Recherche…</p>
          ) : !hits?.length ? (
            <p className="px-3 py-6 text-center text-12 text-muted-foreground">Aucun résultat.</p>
          ) : (
            hits.map((hit) => {
              const Icon = ICONS[hit.kind];
              return (
                <button
                  key={`${hit.kind}-${hit.id}`}
                  type="button"
                  onClick={() => { onPick?.(hit); setOpen(false); }}
                  className="flex w-full items-center gap-2 border-b border-border/40 px-3 py-2 text-left last:border-0 hover:bg-muted/50"
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-13">{hit.title}</span>
                    <span className="block truncate text-11 text-muted-foreground">
                      {KIND_LABEL[hit.kind]}
                      {hit.subtitle ? ` · ${hit.subtitle}` : ""}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
