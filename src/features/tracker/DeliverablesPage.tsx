import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircleIcon, ClockIcon, CodeIcon, FileTextIcon, LinkSimpleIcon,
  PackageIcon, TableIcon, WarningCircleIcon, XCircleIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { formatRelative } from "./pickers";
import { ModuleIllustration } from "./illustrations";
import { EmptyState, PageHeader, Tabs, TextField } from "./ui";
import { fetchProjectDeliverables, type PjProject, type ProjectDeliverable } from "./model";

/**
 * Les livrables produits par les agents sur ce projet — et leur PREUVE.
 *
 * La différence entre cet écran et une galerie de fichiers tient dans un seul
 * mot. Une galerie montre ce qui a été produit ; celle-ci montre en plus à
 * quelle demande chaque chose répond, qui l'a produite, en combien de temps, à
 * quel coût, et si la machine a réellement terminé.
 *
 * C'est ce qui rend le travail d'un agent VÉRIFIABLE. Un rapport de six pages
 * arrivé de nulle part ne se contrôle pas : on le lit ou on le croit. Le même
 * rapport rattaché à un work item, à un run abouti et à des critères
 * d'acceptation se contrôle en trente secondes — on rouvre la demande et on
 * compare.
 *
 * D'où la colonne la plus importante de la page, qui n'est pas le contenu mais
 * l'ÉTAT DU RUN : un livrable produit par un run échoué existe bel et bien, et
 * ne vaut rien. Le masquer serait mentir ; le présenter comme les autres aussi.
 */

type Tab = "all" | "proven" | "unproven";

const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "Tout" },
  { key: "proven", label: "Aboutis" },
  { key: "unproven", label: "À vérifier" },
];

const KIND_ICON: Record<string, typeof FileTextIcon> = {
  report: FileTextIcon,
  markdown: FileTextIcon,
  document: FileTextIcon,
  json: TableIcon,
  spreadsheet: TableIcon,
  code: CodeIcon,
  url: LinkSimpleIcon,
  file: PackageIcon,
};

export function DeliverablesPage({ project }: { project: PjProject }) {
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ProjectDeliverable | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["pj_project_deliverables", project.id],
    queryFn: () => fetchProjectDeliverables(project.id),
  });

  const all = data ?? [];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((d) => {
      // « Abouti » veut dire que le run a réussi. Un livrable dont le run a
      // échoué ou tourne encore n'est pas faux — il est INVÉRIFIÉ, ce qui n'est
      // pas la même chose et ne se range pas au même endroit.
      if (tab === "proven" && d.run_status !== "succeeded") return false;
      if (tab === "unproven" && d.run_status === "succeeded") return false;
      if (!q) return true;
      return d.name.toLowerCase().includes(q)
        || (d.issue_name ?? "").toLowerCase().includes(q)
        || (d.agent_name ?? "").toLowerCase().includes(q);
    });
  }, [all, tab, query]);

  const counts = useMemo(() => ({
    all: all.length,
    proven: all.filter((d) => d.run_status === "succeeded").length,
    unproven: all.filter((d) => d.run_status !== "succeeded").length,
  }), [all]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={<PackageIcon className="h-4 w-4" />}
        title="Livrables"
        subtitle="Ce que les agents ont produit sur ce projet, et de quoi le vérifier."
        actions={
          <>
            <Tabs
              value={tab}
              onChange={setTab}
              options={TABS.map((t) => ({ ...t, count: counts[t.key] }))}
            />
            <div className="w-48">
              <TextField
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Chercher…"
              />
            </div>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? null : error ? (
          <EmptyState
            icon={<WarningCircleIcon className="h-5 w-5" />}
            title="Les livrables n'ont pas pu être chargés"
            hint={error instanceof Error ? error.message : String(error)}
          />
        ) : !shown.length ? (
          <EmptyState
            illustration={<ModuleIllustration className="w-full" />}
            title={all.length ? "Rien dans cette catégorie" : "Aucun livrable"}
            hint={all.length
              ? "Changez d'onglet pour voir le reste."
              : "Confiez un work item à un agent : ce qu'il produira arrivera ici, rattaché à la demande qui l'a motivé."}
          />
        ) : (
          <ul className="px-4 pb-6">
            {shown.map((d) => (
              <DeliverableRow
                key={d.id}
                deliverable={d}
                project={project}
                onOpen={() => setOpen(d)}
              />
            ))}
          </ul>
        )}
      </div>

      {open && <DeliverablePanel deliverable={open} project={project} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** L'issue d'un run, dite en clair et en couleur. */
function RunBadge({ status }: { status: string | null }) {
  const meta = status === "succeeded"
    ? { label: "Abouti", icon: CheckCircleIcon, className: "bg-emerald-500/15 text-emerald-600" }
    : status === "failed"
      ? { label: "Échoué", icon: XCircleIcon, className: "bg-red-500/15 text-red-600" }
      : status === "running" || status === "queued"
        ? { label: status === "running" ? "En cours" : "En file", icon: ClockIcon, className: "bg-amber-500/15 text-amber-600" }
        : { label: "Sans run", icon: WarningCircleIcon, className: "bg-muted text-tertiary" };

  return (
    <span className={cn(
      "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-11 font-medium",
      meta.className,
    )}>
      <meta.icon className="h-3 w-3" />
      {meta.label}
    </span>
  );
}

function DeliverableRow({
  deliverable: d, project, onOpen,
}: { deliverable: ProjectDeliverable; project: PjProject; onOpen: () => void }) {
  const Icon = KIND_ICON[d.kind] ?? PackageIcon;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 border-b border-border/40 py-2.5 text-left transition-colors hover:bg-muted/30"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded bg-muted text-tertiary">
          <Icon className="h-4 w-4" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-13 font-medium">{d.name}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-11 text-tertiary">
            {/* La DEMANDE d'abord : c'est elle qui donne son sens au livrable,
                et c'est la première chose qu'on vérifie. */}
            {d.issue_ref ? (
              <>
                <span className="shrink-0 font-mono text-10 text-placeholder">{d.issue_ref}</span>
                <span className="min-w-0 truncate">{d.issue_name}</span>
              </>
            ) : (
              <span className="italic">Sans work item rattaché</span>
            )}
          </span>
        </span>

        {d.agent_name && (
          <span className="hidden shrink-0 text-11 text-tertiary sm:block">{d.agent_name}</span>
        )}

        {/* Le coût et la durée : deux nombres qui disent ce que la machine a
            réellement dépensé. Sans eux, « autonome » ne veut rien dire. */}
        {d.run_seconds != null && (
          <span className="hidden shrink-0 text-11 tabular-nums text-placeholder md:block">
            {d.run_seconds < 60 ? `${d.run_seconds} s` : `${Math.round(d.run_seconds / 60)} min`}
          </span>
        )}
        {d.run_cost_usd != null && Number(d.run_cost_usd) > 0 && (
          <span className="hidden shrink-0 text-11 tabular-nums text-placeholder lg:block">
            ${Number(d.run_cost_usd).toFixed(3)}
          </span>
        )}

        <RunBadge status={d.run_status} />

        <span className="shrink-0 text-11 text-placeholder">{formatRelative(d.created_at)}</span>
      </button>
    </li>
  );
}

/**
 * La fiche d'un livrable : son contenu ET sa provenance.
 *
 * Les deux sont côte à côte, jamais l'un derrière l'autre : juger un résultat
 * demande de voir en même temps ce qu'il dit et d'où il vient. Une provenance
 * rangée dans un second onglet ne serait jamais ouverte.
 */
function DeliverablePanel({
  deliverable: d, project, onClose,
}: { deliverable: ProjectDeliverable; project: PjProject; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-30">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
      <aside className="absolute inset-y-0 right-0 flex w-full flex-col border-l border-border bg-card shadow-overlay-200 md:w-[560px]">
        <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="min-w-0 flex-1 truncate text-14 font-medium">{d.name}</span>
          <RunBadge status={d.run_status} />
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:bg-muted hover:text-foreground"
          >
            <XCircleIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <dl className="space-y-2 border-b border-border bg-muted/20 px-4 py-3">
            <Row label="Demande">
              {d.issue_ref
                ? <span className="text-12">{d.issue_ref} · {d.issue_name}</span>
                : <span className="text-12 text-placeholder">Aucune</span>}
            </Row>
            <Row label="Mission">
              <span className="text-12">{d.mission_title ?? "—"}</span>
            </Row>
            <Row label="Agent">
              <span className="text-12">{d.agent_name ?? "—"}</span>
            </Row>
            <Row label="Durée">
              <span className="text-12 tabular-nums">
                {d.run_seconds == null
                  ? "—"
                  : d.run_seconds < 60 ? `${d.run_seconds} s` : `${Math.round(d.run_seconds / 60)} min`}
              </span>
            </Row>
            <Row label="Coût">
              <span className="text-12 tabular-nums">
                {d.run_cost_usd == null ? "—" : `$${Number(d.run_cost_usd).toFixed(4)}`}
              </span>
            </Row>
            <Row label="Produit">
              <span className="text-12">{formatRelative(d.created_at)}</span>
            </Row>
          </dl>

          <div className="p-4">
            {d.file_url ? (
              <a
                href={d.file_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-12 hover:bg-muted"
              >
                <LinkSimpleIcon className="h-3.5 w-3.5" /> Ouvrir le fichier
              </a>
            ) : d.content ? (
              // Le contenu brut, en pleine largeur et en chasse fixe : la
              // plupart des livrables sont du JSON ou du markdown, et les
              // rendre « joliment » ici masquerait ce qui a réellement été
              // produit — c'est justement ce qu'on vient contrôler.
              <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-11 leading-relaxed">
                {d.content}
              </pre>
            ) : (
              <p className="text-12 text-placeholder">Ce livrable n&apos;a pas de contenu.</p>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-11 text-tertiary">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
