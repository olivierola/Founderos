import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon, ArrowSquareOutIcon, BracketsCurlyIcon, ClipboardTextIcon, CloudArrowUpIcon,
  DatabaseIcon, DotsThreeIcon, FileIcon, FileTextIcon, GitBranchIcon, LinkSimpleIcon,
  MagnifyingGlassIcon, PaletteIcon, PlugsIcon, PlusIcon, TrashIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { formatDate } from "./pickers";
import { LinkIllustration } from "./illustrations";
import { Badge, Card, Chip, EmptyState, Modal, PageHeader, Select, TextAreaField, TextField } from "./ui";
import {
  archiveAsset, assetFileUrl, createAsset, deleteAsset, fetchAssets, fetchPageById, fetchPages,
  updateAsset,
  uploadAssetFile,
  type AssetKind, type PjAsset, type PjProject,
} from "./model";

/**
 * Les ressources d'un projet : ce sur quoi on travaille.
 *
 * Un work item dit ce qu'il faut faire ; il ne disait nulle part sur QUOI. Le
 * dépôt de code, la maquette, le contrat, le jeu de données finissaient collés
 * dans une description, en texte mort — introuvables au second usage, et
 * invisibles pour un agent à qui l'on confie la tâche.
 *
 * Cette page est la bibliothèque du projet : une ressource y est décrite UNE
 * fois, puis rattachée à autant d'items qu'il faut. C'est l'inverse de la pièce
 * jointe, qui appartient à un item et disparaît avec lui.
 */

export const ASSET_KIND_META: Record<AssetKind, { label: string; icon: PhosphorIcon; hint: string }> = {
  repo: { label: "Dépôt", icon: GitBranchIcon, hint: "Un dépôt de code, une branche, une PR." },
  code: { label: "Code", icon: BracketsCurlyIcon, hint: "Un extrait lisible sur place." },
  doc: { label: "Document", icon: FileTextIcon, hint: "Une spec, un contrat, un compte rendu." },
  page: { label: "Page", icon: FileTextIcon, hint: "Une page du wiki de ce projet." },
  design: { label: "Design", icon: PaletteIcon, hint: "Une maquette, une planche, un écran." },
  dataset: { label: "Données", icon: DatabaseIcon, hint: "Un export, une table, un jeu de test." },
  api: { label: "API", icon: PlugsIcon, hint: "Un service appelé par le travail." },
  file: { label: "Fichier", icon: FileIcon, hint: "Un fichier déposé ici." },
  link: { label: "Lien", icon: LinkSimpleIcon, hint: "Une adresse à visiter." },
  other: { label: "Autre", icon: ClipboardTextIcon, hint: "Le reste." },
};

/** L'ordre d'affichage des genres : du plus structurant au plus anecdotique. */
export const ASSET_KINDS: AssetKind[] = [
  "repo", "code", "doc", "page", "design", "dataset", "api", "file", "link", "other",
];

export function AssetKindIcon({ kind, className }: { kind: AssetKind; className?: string }) {
  const Icon = ASSET_KIND_META[kind]?.icon ?? ClipboardTextIcon;
  return <Icon className={cn("h-4 w-4", className)} />;
}

/** L'adresse à ouvrir pour une ressource, quand elle en a une. */
export function assetHref(a: PjAsset): string | null {
  if (a.url) return a.url;
  if (a.storage_path) return assetFileUrl(a.storage_path);
  return null;
}

export function AssetsPage({ project }: { project: PjProject }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<AssetKind | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState<AssetKind | null>(null);
  const [open, setOpen] = useState<PjAsset | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data: assets } = useQuery({
    queryKey: ["pj_assets", project.id, showArchived],
    queryFn: () => fetchAssets(project.id, { includeArchived: showArchived }),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_assets", project.id] });

  const tags = useMemo(() => {
    const seen = new Map<string, number>();
    for (const a of assets ?? []) for (const t of a.tags) seen.set(t, (seen.get(t) ?? 0) + 1);
    return [...seen.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([t]) => t);
  }, [assets]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (assets ?? []).filter((a) => {
      if (kind && a.kind !== kind) return false;
      if (tag && !a.tags.includes(tag)) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q)
        || a.description.toLowerCase().includes(q)
        || (a.url ?? "").toLowerCase().includes(q)
        || a.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [assets, kind, tag, query]);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        await uploadAssetFile({
          file, pjProjectId: project.id, workspaceId: project.workspace_id,
          createdBy: user?.id ?? null,
        });
      }
      refresh();
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Ressources"
        subtitle="La matière du projet : dépôts, documents, données, liens."
        actions={
          <>
            <input
              ref={fileInput} type="file" multiple hidden
              onChange={(e) => { upload(e.target.files); e.target.value = ""; }}
            />
            <Button
              size="sm" variant="outline" className="h-8"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              <CloudArrowUpIcon className="mr-1 h-4 w-4" />
              {uploading ? "Envoi…" : "Importer"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="h-8">
                  <PlusIcon className="mr-1 h-4 w-4" /> Ajouter
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {ASSET_KINDS.filter((k) => k !== "file").map((k) => {
                  const Icon = ASSET_KIND_META[k].icon;
                  return (
                    <DropdownMenuItem key={k} onClick={() => setCreating(k)}>
                      <Icon className="h-4 w-4" /> {ASSET_KIND_META[k].label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        <div className="relative w-56">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary" />
          <TextField
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Chercher une ressource…"
            className="pl-7"
          />
        </div>
        <Chip active={!kind} onClick={() => setKind(null)}>Tout</Chip>
        {ASSET_KINDS.filter((k) => (assets ?? []).some((a) => a.kind === k)).map((k) => (
          <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? null : k)}>
            {ASSET_KIND_META[k].label}
          </Chip>
        ))}
        {tags.length > 0 && <span className="mx-1 h-4 w-px bg-border" />}
        {tags.map((t) => (
          <Chip key={t} active={tag === t} onClick={() => setTag(tag === t ? null : t)}>#{t}</Chip>
        ))}
        <div className="flex-1" />
        <Chip active={showArchived} onClick={() => setShowArchived(!showArchived)}>
          <ArchiveIcon className="mr-1 h-3 w-3" /> Archivées
        </Chip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!shown.length ? (
          <EmptyState
            illustration={<LinkIllustration className="w-full" />}
            title={assets?.length ? "Aucune ressource ne correspond" : "Aucune ressource"}
            hint={
              assets?.length
                ? "Changez de genre ou effacez la recherche."
                : "Décrivez ici ce sur quoi le projet travaille, le dépôt, la maquette, le jeu de données. Chaque work item pourra ensuite pointer dessus, et les collaborateurs sauront quoi ouvrir."
            }
            action={
              <Button size="sm" className="h-8" onClick={() => setCreating("repo")}>
                <PlusIcon className="mr-1 h-4 w-4" /> Ajouter une ressource
              </Button>
            }
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((a) => (
              <AssetCard
                key={a.id} asset={a}
                onOpen={() => setOpen(a)}
                onChanged={refresh}
              />
            ))}
          </div>
        )}
      </div>

      {creating && (
        <CreateAssetDialog
          project={project} kind={creating}
          onClose={() => setCreating(null)}
          onCreated={() => { setCreating(null); refresh(); }}
        />
      )}

      {open && (
        <AssetDetailDialog
          asset={open}
          onClose={() => setOpen(null)}
          onChanged={() => { refresh(); setOpen(null); }}
        />
      )}
    </div>
  );
}

function AssetCard({
  asset, onOpen, onChanged,
}: { asset: PjAsset; onOpen: () => void; onChanged: () => void }) {
  const href = assetHref(asset);
  return (
    <Card interactive className="group flex flex-col gap-2 p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-muted-foreground"><AssetKindIcon kind={asset.kind} /></span>
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <span className={cn("block truncate text-13 font-medium", asset.archived_at && "line-through opacity-60")}>
            {asset.name}
          </span>
          <span className="block truncate text-11 text-muted-foreground">
            {asset.description || ASSET_KIND_META[asset.kind]?.hint}
          </span>
        </button>
        {href && (
          <a
            href={href} target="_blank" rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
            title="Ouvrir"
          >
            <ArrowSquareOutIcon className="h-3.5 w-3.5" />
          </a>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted">
              <DotsThreeIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onOpen}>Ouvrir la fiche</DropdownMenuItem>
            <DropdownMenuItem onClick={() => archiveAsset(asset.id, !asset.archived_at).then(onChanged)}>
              {asset.archived_at ? "Désarchiver" : "Archiver"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <Badge tone="outline">{ASSET_KIND_META[asset.kind]?.label ?? asset.kind}</Badge>
        {asset.tags.slice(0, 3).map((t) => <Badge key={t}>#{t}</Badge>)}
        <div className="flex-1" />
        <span className="text-10 text-tertiary">{formatDate(asset.updated_at)}</span>
      </div>
    </Card>
  );
}

/**
 * La création, un genre à la fois.
 *
 * Un formulaire unique avec dix champs dont trois servent obligerait à
 * comprendre le modèle avant de poser un lien. Le genre choisi dans le menu
 * décide des champs montrés : une adresse pour un dépôt, un éditeur pour un
 * extrait de code.
 */
export function CreateAssetDialog({
  project, kind: initialKind, presetName, onClose, onCreated,
}: {
  project: PjProject;
  kind: AssetKind;
  presetName?: string;
  onClose: () => void;
  onCreated: (a: PjAsset) => void;
}) {
  const { user } = useAuth();
  const [kind, setKind] = useState<AssetKind>(initialKind);
  const [name, setName] = useState(presetName ?? "");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [language, setLanguage] = useState("");
  const [tags, setTags] = useState("");
  const [pageId, setPageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: pages } = useQuery({
    queryKey: ["pj_pages", project.id],
    queryFn: () => fetchPages(project.id),
    enabled: kind === "page",
  });

  const inline = kind === "code" || kind === "other";
  const isPage = kind === "page";
  const canSubmit = !!name.trim()
    && (isPage ? !!pageId : inline ? !!content.trim() || !!url.trim() : !!url.trim());

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createAsset({
        pjProjectId: project.id, workspaceId: project.workspace_id,
        kind, name: name.trim(), description: description.trim(),
        url: url.trim() || null, content: content.trim() || null, pageId,
        language: language.trim() || null,
        tags: tags.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean),
        createdBy: user?.id ?? null,
      });
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "L'enregistrement a échoué.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open onClose={onClose} busy={busy}
      title="Nouvelle ressource"
      description={ASSET_KIND_META[kind]?.hint}
      footer={
        <>
          <Button size="sm" variant="ghost" className="h-8" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button size="sm" className="h-8" onClick={submit} disabled={!canSubmit || busy}>
            {busy ? "Enregistrement…" : "Ajouter"}
          </Button>
        </>
      }
    >
      <Field label="Genre">
        <Select
          value={kind}
          onChange={(k) => setKind(k)}
          options={ASSET_KINDS.filter((k) => k !== "file").map((k) => ({
            key: k, label: ASSET_KIND_META[k].label, hint: ASSET_KIND_META[k].hint,
          }))}
        />
      </Field>

      <Field label="Nom">
        <TextField value={name} onChange={(e) => setName(e.target.value)} placeholder="Ce qu'on ouvre" autoFocus />
      </Field>

      {isPage ? (
        <Field label="Page du projet">
          <Select
            value={pageId}
            onChange={(id) => {
              setPageId(id);
              // Le nom suit la page tant qu'on ne l'a pas écrit soi-même :
              // saisir deux fois le même titre est un travail de scribe.
              const page = (pages ?? []).find((p) => p.id === id);
              if (page && !name.trim()) setName(page.name || "Page sans titre");
            }}
            options={(pages ?? []).map((p) => ({ key: p.id, label: p.name || "Page sans titre" }))}
            placeholder={pages?.length ? "Choisir une page…" : "Aucune page dans ce projet"}
          />
        </Field>
      ) : (
        <Field label={inline ? "Adresse (facultative)" : "Adresse"}>
          <TextField value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </Field>
      )}

      {inline && (
        <>
          <Field label="Contenu">
            <TextAreaField
              value={content} onChange={(e) => setContent(e.target.value)}
              placeholder="Collez ici l'extrait, la requête, le schéma…"
              className="min-h-[140px] font-mono text-12"
            />
          </Field>
          <Field label="Langage">
            <TextField value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="ts, sql, python…" />
          </Field>
        </>
      )}

      <Field label="À quoi elle sert">
        <TextAreaField
          value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="Une phrase : ce que quelqu'un, ou un collaborateur, doit savoir avant de l'ouvrir."
          className="min-h-[64px]"
        />
      </Field>

      <Field label="Étiquettes">
        <TextField value={tags} onChange={(e) => setTags(e.target.value)} placeholder="back, facturation, v2" />
      </Field>

      {error && <p className="text-11 text-red-600">{error}</p>}
    </Modal>
  );
}

function AssetDetailDialog({
  asset, onClose, onChanged,
}: { asset: PjAsset; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(asset.name);
  const [description, setDescription] = useState(asset.description);
  const [url, setUrl] = useState(asset.url ?? "");
  const [content, setContent] = useState(asset.content ?? "");
  const [tags, setTags] = useState(asset.tags.join(", "));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const href = assetHref(asset);

  // Une ressource « page » n'a pas d'adresse : son contenu vit dans le wiki du
  // projet. On le montre ici en lecture — l'édition reste dans l'éditeur de
  // pages, qui est le seul endroit où elle a un sens.
  const { data: page } = useQuery({
    queryKey: ["pj_page", asset.page_id],
    queryFn: () => fetchPageById(asset.page_id as string),
    enabled: !!asset.page_id,
  });

  const save = async () => {
    setBusy(true);
    try {
      await updateAsset(asset.id, {
        name: name.trim() || asset.name,
        description: description.trim(),
        url: url.trim() || null,
        content: content.trim() || null,
        tags: tags.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean),
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open onClose={onClose} busy={busy} size="lg"
      title={
        <span className="flex items-center gap-2">
          <AssetKindIcon kind={asset.kind} />
          {asset.name}
        </span>
      }
      footer={
        <>
          {confirmDelete ? (
            <>
              <span className="mr-auto text-11 text-muted-foreground">
                Supprimer définitivement ? Les work items la perdront.
              </span>
              <Button size="sm" variant="ghost" className="h-8" onClick={() => setConfirmDelete(false)}>
                Annuler
              </Button>
              <Button
                size="sm" variant="destructive" className="h-8"
                onClick={async () => { await deleteAsset(asset.id, asset.storage_path); onChanged(); }}
              >
                Supprimer
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm" variant="ghost" className="mr-auto h-8 text-muted-foreground"
                onClick={() => setConfirmDelete(true)}
              >
                <TrashIcon className="mr-1 h-3.5 w-3.5" /> Supprimer
              </Button>
              <Button
                size="sm" variant="ghost" className="h-8"
                onClick={() => archiveAsset(asset.id, !asset.archived_at).then(onChanged)}
              >
                {asset.archived_at ? "Désarchiver" : "Archiver"}
              </Button>
              <Button size="sm" className="h-8" onClick={save} disabled={busy}>Enregistrer</Button>
            </>
          )}
        </>
      }
    >
      <Field label="Nom">
        <TextField value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Adresse">
        <div className="flex items-center gap-1.5">
          <TextField value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          {href && (
            <a
              href={href} target="_blank" rel="noreferrer"
              className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Ouvrir"
            >
              <ArrowSquareOutIcon className="h-4 w-4" />
            </a>
          )}
        </div>
      </Field>

      {page && (
        <div className="space-y-1">
          <span className="text-11 font-medium text-muted-foreground">Page du projet</span>
          <div
            className="prose prose-sm max-h-64 max-w-none overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-3 dark:prose-invert"
            // Le contenu vient de l'éditeur du projet, écrit par les membres de
            // l'espace — la même confiance que partout ailleurs dans le wiki.
            dangerouslySetInnerHTML={{ __html: page.description_html || "<p>Page vide.</p>" }}
          />
        </div>
      )}

      {asset.storage_path && (
        <p className="text-11 text-muted-foreground">
          Fichier déposé · {Math.max(1, Math.round(asset.size_bytes / 1024))} Ko
        </p>
      )}

      <Field label="À quoi elle sert">
        <TextAreaField
          value={description} onChange={(e) => setDescription(e.target.value)}
          className="min-h-[64px]"
        />
      </Field>

      {(asset.content !== null || asset.kind === "code") && (
        <Field label="Contenu">
          <TextAreaField
            value={content} onChange={(e) => setContent(e.target.value)}
            className="min-h-[200px] font-mono text-12"
          />
        </Field>
      )}

      <Field label="Étiquettes">
        <TextField value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-11 font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * Le sélecteur posé sur une fiche de work item.
 *
 * Il montre la bibliothèque DU PROJET, et laisse en créer une à la volée : la
 * ressource qui manque au moment où l'on décrit la tâche est précisément celle
 * qu'on n'ira jamais ajouter depuis un autre écran.
 */
export function AssetPickerDialog({
  project, excludeIds, onClose, onPick,
}: {
  project: PjProject;
  excludeIds: Set<string>;
  onClose: () => void;
  onPick: (asset: PjAsset) => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState<AssetKind | null>(null);
  const { data: assets } = useQuery({
    queryKey: ["pj_assets", project.id, false],
    queryFn: () => fetchAssets(project.id),
  });

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (assets ?? []).filter((a) =>
      !excludeIds.has(a.id)
      && (!q || a.name.toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q))));
  }, [assets, excludeIds, query]);

  if (creating) {
    return (
      <CreateAssetDialog
        project={project} kind={creating} presetName={query.trim()}
        onClose={() => setCreating(null)}
        onCreated={async (a) => { setCreating(null); await onPick(a); }}
      />
    );
  }

  return (
    <Modal
      open onClose={onClose}
      title="Ajouter une ressource"
      description="Celles du projet. Si elle n'existe pas encore, créez-la ici."
      footer={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-8">
              <PlusIcon className="mr-1 h-4 w-4" /> Nouvelle ressource
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {ASSET_KINDS.filter((k) => k !== "file").map((k) => {
              const Icon = ASSET_KIND_META[k].icon;
              return (
                <DropdownMenuItem key={k} onClick={() => setCreating(k)}>
                  <Icon className="h-4 w-4" /> {ASSET_KIND_META[k].label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary" />
        <TextField
          value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Chercher…" className="pl-7" autoFocus
        />
      </div>

      <div className="max-h-[50vh] space-y-1 overflow-y-auto">
        {shown.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onPick(a)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted"
          >
            <span className="text-muted-foreground"><AssetKindIcon kind={a.kind} /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-13">{a.name}</span>
              <span className="block truncate text-11 text-muted-foreground">
                {a.description || a.url || ASSET_KIND_META[a.kind]?.label}
              </span>
            </span>
            <PlusIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        ))}
        {!shown.length && (
          <p className="px-2 py-6 text-center text-12 text-muted-foreground">
            {assets?.length ? "Aucune ressource ne correspond." : "La bibliothèque du projet est vide."}
          </p>
        )}
      </div>
    </Modal>
  );
}

