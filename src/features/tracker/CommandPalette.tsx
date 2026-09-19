import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowsClockwiseIcon, FileTextIcon, FlagIcon, PlusIcon, SquaresFourIcon,
  StackIcon, SuitcaseSimpleIcon,
} from "@phosphor-icons/react";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { fetchInitiatives, fetchProjects, searchTracker, type SearchHit } from "./model";

/**
 * La palette ⌘K.
 *
 * Elle sert deux usages qu'on confond souvent : ALLER quelque part, et FAIRE
 * quelque chose. Les deux sont ici parce qu'ils partagent le même geste — on
 * tape ce qu'on a en tête sans savoir si c'est un nom ou une action — mais ils
 * sont séparés en sections, sinon « nouveau » et « Nouvelle facturation » se
 * mélangent dans une liste où l'on ne distingue plus ce qui va se produire.
 *
 * La recherche interroge la base après 200 ms de silence : une requête par
 * frappe est du gaspillage pour des résultats remplacés à la lettre suivante.
 */
export function TrackerCommandPalette({
  dashboardId, onOpenProject, onOpenInitiative, onNavigate, onNewIssue,
}: {
  dashboardId: string;
  onOpenProject: (id: string) => void;
  onOpenInitiative: (id: string) => void;
  onNavigate: (view: string) => void;
  onNewIssue: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [query, setQuery] = useState("");

  // ⌘K / Ctrl+K, en capture globale. On ignore la frappe quand le focus est
  // dans un champ : intercepter le raccourci pendant qu'on écrit un titre
  // ferait disparaître la saisie sous une palette.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
      const el = document.activeElement;
      const typing = el instanceof HTMLElement
        && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(raw), 200);
    return () => clearTimeout(timer);
  }, [raw]);

  const { data: projects } = useQuery({
    queryKey: ["pj_projects", dashboardId],
    enabled: open,
    queryFn: () => fetchProjects(dashboardId),
  });
  const { data: initiatives } = useQuery({
    queryKey: ["pj_initiatives", dashboardId],
    enabled: open,
    queryFn: () => fetchInitiatives(dashboardId),
  });
  const { data: hits } = useQuery({
    queryKey: ["pj_search", dashboardId, query],
    enabled: open && query.trim().length >= 2,
    queryFn: () => searchTracker(dashboardId, query),
  });

  const run = (fn: () => void) => { setOpen(false); setRaw(""); fn(); };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        value={raw} onValueChange={setRaw}
        placeholder="Chercher un work item, un projet, ou lancer une action…"
      />
      <CommandList>
        <CommandEmpty>Aucun résultat.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem value="nouveau work item créer" onSelect={() => run(onNewIssue)}>
            <PlusIcon className="h-4 w-4" /> Nouveau work item
          </CommandItem>
          <CommandItem value="mon travail assigné" onSelect={() => run(() => onNavigate("my-work"))}>
            <SquaresFourIcon className="h-4 w-4" /> Votre travail
          </CommandItem>
          <CommandItem value="workgraph graphe" onSelect={() => run(() => onNavigate("workgraph"))}>
            <StackIcon className="h-4 w-4" /> Workgraph
          </CommandItem>
        </CommandGroup>

        {(hits ?? []).length > 0 && (
          <CommandGroup heading="Résultats">
            {(hits ?? []).map((hit: SearchHit) => (
              <CommandItem
                key={`${hit.kind}-${hit.id}`}
                value={`${hit.title} ${hit.subtitle}`}
                onSelect={() => run(() => onOpenProject(hit.pj_project_id))}
              >
                {hit.kind === "cycle" ? <ArrowsClockwiseIcon className="h-4 w-4" />
                  : hit.kind === "page" ? <FileTextIcon className="h-4 w-4" />
                  : <SquaresFourIcon className="h-4 w-4" />}
                <span className="flex-1 truncate">{hit.title}</span>
                <span className="text-11 text-muted-foreground">{hit.subtitle}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Projets">
          {(projects ?? []).map((p) => (
            <CommandItem
              key={p.id} value={`${p.identifier} ${p.name}`}
              onSelect={() => run(() => onOpenProject(p.id))}
            >
              <SuitcaseSimpleIcon className="h-4 w-4" />
              <span className="flex-1 truncate">{p.name}</span>
              <span className="font-mono text-10 text-muted-foreground">{p.identifier}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        {(initiatives ?? []).length > 0 && (
          <CommandGroup heading="Initiatives">
            {(initiatives ?? []).map((i) => (
              <CommandItem key={i.id} value={i.name} onSelect={() => run(() => onOpenInitiative(i.id))}>
                <FlagIcon className="h-4 w-4" />
                <span className="flex-1 truncate">{i.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
