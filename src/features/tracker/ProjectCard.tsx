import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DotsThreeIcon, GearSixIcon, LinkSimpleIcon, LockSimpleIcon, StarIcon,
} from "@phosphor-icons/react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { readEmoji } from "./LogoPicker";
import { MemberAvatar, memberName } from "./pickers";
import {
  fetchIssues, fetchMembers, fetchProjectMembers, fetchStates, updateProject,
  type PjProject,
} from "./model";

/**
 * La carte d'un projet.
 *
 * Deux bandes de hauteurs fixes, comme dans Plane : une couverture de 118 px et
 * un corps de 104 px. Les figer plutôt que de les laisser s'adapter au contenu
 * est ce qui fait qu'une grille de douze projets reste une grille — des cartes
 * de hauteurs variables donnent un mur en escalier où l'œil ne trouve plus de
 * ligne de lecture.
 *
 * La couverture n'est pas décorative : c'est le seul endroit d'une liste où un
 * projet devient reconnaissable AVANT d'être lu. Faute d'image, on en dérive
 * une du nom — stable, donc mémorisable, ce qu'une couleur aléatoire ne serait
 * pas.
 */
export function ProjectCard({
  project, favourite, onToggleFavourite, onOpen, onOpenSettings, onChanged,
}: {
  project: PjProject;
  favourite: boolean;
  onToggleFavourite: () => void;
  onOpen: () => void;
  onOpenSettings?: () => void;
  onChanged: () => void;
}) {
  const { data: issues } = useQuery({
    queryKey: ["pj_issues", { pjProjectId: project.id }],
    queryFn: () => fetchIssues({ pjProjectId: project.id }),
  });
  const { data: states } = useQuery({
    queryKey: ["pj_states", project.id],
    queryFn: () => fetchStates(project.id),
  });
  const { data: memberRows } = useQuery({
    queryKey: ["pj_project_members", project.id],
    queryFn: () => fetchProjectMembers(project.id),
  });
  const { data: workspaceMembers } = useQuery({
    queryKey: ["pj_members", project.workspace_id],
    queryFn: () => fetchMembers(project.workspace_id),
  });

  const done = useMemo(() => {
    const groupOf = new Map((states ?? []).map((s) => [s.id, s.group]));
    return (issues ?? []).filter((i) => groupOf.get(i.state_id ?? "") === "completed").length;
  }, [issues, states]);

  const total = issues?.length ?? 0;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const emoji = readEmoji(project.logo_props);
  const cover = coverFor(project);

  const members = (memberRows ?? [])
    .map((m) => (workspaceMembers ?? []).find((w) => w.user_id === m.user_id))
    .filter(Boolean)
    .slice(0, 4);

  return (
    <article className="overflow-hidden rounded-lg border border-border/70 bg-card shadow-raised-100 transition-colors hover:border-border">
      {/* ── Couverture ─────────────────────────────────────────────────── */}
      <div className="relative h-[118px] w-full" style={{ background: cover }}>
        {project.cover_image && (
          <img
            src={project.cover_image} alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        {/* Le dégradé n'est pas un effet : sans lui, un texte blanc posé sur une
            photo claire devient illisible, et on ne maîtrise pas la photo. */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/25 to-transparent" />

        <div className="absolute right-3 top-3 flex items-center gap-1.5">
          <CoverButton
            title={favourite ? "Retirer des favoris" : "Ajouter aux favoris"}
            onClick={onToggleFavourite}
            className={favourite ? "text-amber-300" : undefined}
          >
            <StarIcon className="h-3.5 w-3.5" weight={favourite ? "fill" : "regular"} />
          </CoverButton>
          <CoverButton
            title="Copier la référence"
            onClick={() => navigator.clipboard?.writeText(project.identifier)}
          >
            <LinkSimpleIcon className="h-3.5 w-3.5" />
          </CoverButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex h-6 w-6 items-center justify-center rounded bg-white/15 text-white backdrop-blur transition-colors hover:bg-white/25">
                <DotsThreeIcon className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onOpenSettings && (
                <DropdownMenuItem onClick={onOpenSettings}>
                  <GearSixIcon className="h-4 w-4" /> Réglages
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() =>
                  updateProject(project.id, { archived_at: new Date().toISOString() }).then(onChanged)}
              >
                Archiver
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <button
          type="button"
          onClick={onOpen}
          className="absolute inset-x-0 bottom-0 flex items-end gap-2.5 px-4 pb-4 text-left"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-white/15 text-16 backdrop-blur">
            {emoji ?? <span className="font-mono text-11 font-semibold text-white">
              {project.identifier.slice(0, 2)}
            </span>}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-14 font-semibold text-white">{project.name}</span>
            <span className="flex items-center gap-1.5 text-11 font-medium text-white/80">
              {project.identifier}
              {project.network === 0 && <LockSimpleIcon className="h-3 w-3" />}
            </span>
          </span>
        </button>
      </div>

      {/* ── Corps ──────────────────────────────────────────────────────── */}
      <div className="flex h-[104px] flex-col justify-between p-4">
        <p className={cn(
          "line-clamp-2 text-13",
          project.description ? "text-muted-foreground" : "italic text-muted-foreground/70",
        )}>
          {project.description || "Aucune description."}
        </p>

        <div className="flex items-center gap-2">
          {members.length ? (
            <span className="flex -space-x-1.5">
              {members.map((m) => (
                <span key={m!.user_id} className="ring-2 ring-card" title={memberName(m)}>
                  <MemberAvatar member={m} />
                </span>
              ))}
            </span>
          ) : (
            <span className="text-11 italic text-muted-foreground">Aucun membre</span>
          )}

          <div className="flex-1" />

          {/* L'avancement en toutes lettres plutôt qu'en barre : sur une carte
              de cette taille, une barre de 60 px ne se lit qu'à peu près, et
              « 12/30 » se lit exactement. */}
          <span className="text-11 tabular-nums text-muted-foreground">
            {done}/{total} · {percent}%
          </span>
        </div>
      </div>
    </article>
  );
}

function CoverButton({
  children, title, onClick, className,
}: {
  children: React.ReactNode; title: string; onClick: () => void; className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded bg-white/15 text-white backdrop-blur transition-colors hover:bg-white/25",
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * La couverture par défaut, dérivée de l'identifiant.
 *
 * Elle est STABLE : le même projet garde la même couleur d'une session à
 * l'autre, ce qui la rend mémorisable. Une teinte tirée au hasard serait jolie
 * une fois et inutile ensuite, puisqu'elle ne dirait plus rien du projet.
 *
 * La saturation et la luminosité sont fixes, seule la teinte varie : c'est ce
 * qui garantit que le texte blanc posé dessus reste lisible quelle que soit la
 * valeur tirée.
 */
function coverFor(project: PjProject): string {
  let hash = 0;
  for (const ch of project.identifier) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${hash} 45% 38%), hsl(${(hash + 40) % 360} 45% 26%))`;
}
