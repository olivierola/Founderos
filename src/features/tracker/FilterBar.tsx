import { useState } from "react";
import {
  CaretDownIcon, FunnelIcon, MagnifyingGlassIcon, SlidersHorizontalIcon, XIcon,
  ListBulletsIcon, KanbanIcon, CalendarBlankIcon, TableIcon, ChartBarHorizontalIcon,
  ChartBarIcon,
} from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

import { cn } from "@/lib/utils";
import { CheckMark, Checkbox, Chip, Select } from "./ui";
import {
  DISPLAY_PROPERTY_LABELS, GROUP_BY_OPTIONS, LAYOUTS, ORDER_BY_OPTIONS,
  countActiveFilters, EMPTY_FILTERS,
  type DisplayFilters, type DisplayProperties, type Filters, type GroupBy,
  type Layout, type OrderBy,
} from "./filters";
import { PRIORITIES, STATE_GROUPS, type Member, type PjCycle, type PjLabel, type PjModule, type PjState, type TrackerAgent } from "./model";
import { AgentAvatar } from "./AgentPicker";
import { MemberAvatar, PriorityIcon, StateIcon, memberName } from "./pickers";
import { TextField } from "./ui";

/**
 * La barre au-dessus d'un board : recherche, layout, filtres, affichage.
 *
 * Elle manipule exactement les trois objets qu'une vue sauvegarde (`filters`,
 * `display`, `properties`), ce qui permet d'enregistrer l'état courant sans le
 * traduire — « Enregistrer comme vue » copie les trois tels quels.
 */

const LAYOUT_ICONS: Record<Layout, typeof ListBulletsIcon> = {
  list: ListBulletsIcon,
  kanban: KanbanIcon,
  calendar: CalendarBlankIcon,
  spreadsheet: TableIcon,
  gantt: ChartBarHorizontalIcon,
};

export interface FilterContext {
  /** Les agents du service. Facultatif : un écran sans agents n'en a pas. */
  agents?: TrackerAgent[];
  states: PjState[];
  labels: PjLabel[];
  members: Member[];
  cycles: PjCycle[];
  modules: PjModule[];
}

export function FilterBar({
  filters, display, properties, ctx, title, count,
  onFilters, onDisplay, onProperties, trailing, onOpenAnalytics, breadcrumb,
}: {
  filters: Filters;
  display: DisplayFilters;
  properties: DisplayProperties;
  ctx: FilterContext;
  /** Le libellé de gauche et son compteur, comme « Work items 112 ». */
  title?: string;
  count?: number;
  onFilters: (f: Filters) => void;
  onDisplay: (d: DisplayFilters) => void;
  onProperties: (p: DisplayProperties) => void;
  onOpenAnalytics?: () => void;
  /** Boutons propres à l'écran hôte (créer, enregistrer la vue…). */
  trailing?: React.ReactNode;
  /**
   * Un fil d'Ariane, à la place du titre.
   *
   * Il sert aux écrans où le board n'est PAS la destination mais son contenu :
   * une vue enregistrée, un cycle, un module. Là, la question « où suis-je »
   * précède « combien y en a-t-il », et un titre nu n'y répond pas. Le passer
   * ici plutôt que dans une seconde barre au-dessus évite d'empiler deux
   * rangées de commandes pour un seul écran.
   */
  breadcrumb?: React.ReactNode;
}) {
  const active = countActiveFilters(filters);
  const [searching, setSearching] = useState(false);

  return (
    <div className="space-y-2 border-b border-border/60 px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Le titre + compteur tient la gauche, comme chez Plane : le nombre
            d'items est la première chose qu'on vérifie après avoir filtré. */}
        {breadcrumb ?? (title && (
          <div className="flex items-center gap-2">
            <span className="text-13 font-medium">{title}</span>
            {count !== undefined && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-11 font-medium text-muted-foreground">
                {count}
              </span>
            )}
          </div>
        ))}

        <div className="flex-1" />

        {/* Les cinq layouts en rangée d'icônes, comme dans Plane : c'est le
            réglage qu'on change le plus souvent, il doit tenir en un clic. */}
        <div className="flex h-7 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
          {LAYOUTS.map((l) => {
            const Icon = LAYOUT_ICONS[l.key];
            return (
              <button
                key={l.key}
                type="button"
                title={l.label}
                aria-label={l.label}
                aria-pressed={display.layout === l.key}
                onClick={() => onDisplay({ ...display, layout: l.key })}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-tertiary transition-all hover:text-foreground",
                  display.layout === l.key && "border-border bg-card text-foreground shadow-raised-100",
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          })}
        </div>

        {/* La recherche est repliée derrière une loupe : elle sert moins souvent
            que les filtres, et un champ permanent mangeait la barre. */}
        {searching || filters.query ? (
          <div className="relative w-56">
            <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <TextField
              autoFocus
              value={filters.query}
              onChange={(e) => onFilters({ ...filters, query: e.target.value })}
              onBlur={() => { if (!filters.query) setSearching(false); }}
              placeholder="Rechercher…"
              className="h-8 pl-8 text-14"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setSearching(true)}
            title="Rechercher"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <MagnifyingGlassIcon className="h-4 w-4" />
          </button>
        )}

        <FiltersMenu filters={filters} ctx={ctx} onChange={onFilters} count={active} />
        <DisplayMenu
          display={display} properties={properties}
          onDisplay={onDisplay} onProperties={onProperties}
          layout={display.layout}
        />
        {onOpenAnalytics && (
          <button
            type="button"
            onClick={onOpenAnalytics}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-12 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChartBarIcon className="h-4 w-4" /> Analytics
          </button>
        )}
        {trailing}
      </div>

      {active > 0 && (
        <AppliedFilters filters={filters} ctx={ctx} onChange={onFilters} />
      )}
    </div>
  );
}

// ── Filtres ─────────────────────────────────────────────────────────────────

type FilterKey = keyof Omit<Filters, "query">;

const DATE_TOKENS: { key: string; label: string }[] = [
  { key: "overdue", label: "En retard" },
  { key: "today", label: "Aujourd'hui" },
  { key: "tomorrow", label: "Demain" },
  { key: "this_week", label: "Cette semaine" },
  { key: "next_week", label: "Semaine prochaine" },
  { key: "next_month", label: "30 prochains jours" },
  { key: "none", label: "Sans date" },
];

function FiltersMenu({
  filters, ctx, onChange, count,
}: { filters: Filters; ctx: FilterContext; onChange: (f: Filters) => void; count: number }) {
  const [open, setOpen] = useState(false);

  /**
   * QUELS filtres sont posés, pas seulement combien.
   *
   * Un compteur dit qu'on ne voit pas tout ; il ne dit pas ce qui est écarté,
   * et il faut ouvrir le menu pour l'apprendre. Nommer les champs concernés —
   * « Priorité · Assignés » — répond à la question sans ce détour. On s'arrête
   * aux noms des champs, pas à leurs valeurs : « Priorité » tient sur un
   * bouton, « urgent, haute, moyenne » non.
   */
  const activeFields = ([
    ["state", "État"], ["state_group", "Groupe"], ["priority", "Priorité"],
    ["assignees", "Assignés"], ["agents", "Agents"], ["labels", "Labels"], ["cycle", "Cycle"],
    ["module", "Module"], ["issue_type", "Type"], ["created_by", "Créé par"],
    ["target_date", "Échéance"],
  ] as const)
    // Les clés viennent du tuple, donc le typage suit : on lit le champ par
    // index sans fabriquer de Record, que TypeScript refuse ici — un type à
    // champs nommés ne devient pas un dictionnaire sans détour par unknown.
    .filter(([k]) => {
      const v = filters[k];
      return Array.isArray(v) && v.length > 0;
    })
    .map(([, label]) => label);

  const toggle = (key: FilterKey, value: string) => {
    // `?? []` : un filtre enregistré avant l'ajout d'un champ ne le porte pas.
    const list = (filters[key] as string[] | undefined) ?? [];
    onChange({
      ...filters,
      [key]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value],
    } as Filters);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-12 transition-colors",
            count > 0
              ? "border-primary/40 bg-primary/10 font-medium text-primary"
              : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <FunnelIcon className="h-4 w-4" />
          {/* Rien d'écrit quand aucun filtre n'est posé : la barre est déjà
              chargée, et une icône d'entonnoir se lit sans légende. Dès qu'un
              filtre existe, en revanche, il faut dire LEQUEL — c'est ce qui
              explique une liste plus courte que prévu. Au-delà de deux champs,
              on retombe sur le compte : trois noms sur un bouton deviennent
              une phrase qu'on ne lit plus. */}
          {activeFields.length > 0 && activeFields.length <= 2 && (
            <span className="max-w-[160px] truncate">{activeFields.join(" · ")}</span>
          )}
          {activeFields.length > 2 && <span>{activeFields.length} champs</span>}
          {count > 0 && (
            <span className="rounded bg-primary px-1 text-10 text-primary-foreground">{count}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        <Command>
          <CommandInput placeholder="Filtrer par…" />
          <CommandList className="max-h-[420px]">
            <CommandEmpty>Aucun critère.</CommandEmpty>

            <CommandGroup heading="Priorité">
              {PRIORITIES.map((p) => (
                <CommandItem key={p.key} value={`priorité ${p.label}`} onSelect={() => toggle("priority", p.key)}>
                  <CheckMark checked={filters.priority.includes(p.key)} />
                  <PriorityIcon priority={p.key} />
                  <span className="flex-1">{p.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>

            <CommandGroup heading="État">
              {ctx.states.map((s) => (
                <CommandItem key={s.id} value={`état ${s.name}`} onSelect={() => toggle("state", s.id)}>
                  <CheckMark checked={filters.state.includes(s.id)} />
                  <StateIcon group={s.group} color={s.color} />
                  <span className="flex-1 truncate">{s.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>

            <CommandGroup heading="Groupe d'état">
              {STATE_GROUPS.map((g) => (
                <CommandItem key={g.key} value={`groupe ${g.label}`} onSelect={() => toggle("state_group", g.key)}>
                  <CheckMark checked={filters.state_group.includes(g.key)} />
                  <StateIcon group={g.key} color={g.color} />
                  <span className="flex-1">{g.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>

            <CommandGroup heading="Assignés">
              <CommandItem value="assigné personne" onSelect={() => toggle("assignees", "none")}>
                <CheckMark checked={filters.assignees.includes("none")} />
                <span className="flex-1 text-muted-foreground">Non assigné</span>
              </CommandItem>
              {ctx.members.map((m) => (
                <CommandItem key={m.user_id} value={`assigné ${memberName(m)}`} onSelect={() => toggle("assignees", m.user_id)}>
                  <CheckMark checked={filters.assignees.includes(m.user_id)} />
                  <MemberAvatar member={m} size={18} />
                  <span className="flex-1 truncate">{memberName(m)}</span>
                </CommandItem>
              ))}
            </CommandGroup>

            {(ctx.agents ?? []).length > 0 && (
              <CommandGroup heading="Agents">
                <CommandItem value="agent aucun" onSelect={() => toggle("agents", "none")}>
                  <CheckMark checked={(filters.agents ?? []).includes("none")} />
                  <span className="flex-1 text-muted-foreground">Sans agent</span>
                </CommandItem>
                {(ctx.agents ?? []).map((a) => (
                  <CommandItem key={a.id} value={`agent ${a.name}`} onSelect={() => toggle("agents", a.id)}>
                    <CheckMark checked={(filters.agents ?? []).includes(a.id)} />
                    <AgentAvatar agent={a} size={18} />
                    <span className="flex-1 truncate">{a.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {ctx.labels.length > 0 && (
              <CommandGroup heading="Labels">
                <CommandItem value="label aucun" onSelect={() => toggle("labels", "none")}>
                  <CheckMark checked={filters.labels.includes("none")} />
                  <span className="flex-1 text-muted-foreground">Sans label</span>
                </CommandItem>
                {ctx.labels.map((l) => (
                  <CommandItem key={l.id} value={`label ${l.name}`} onSelect={() => toggle("labels", l.id)}>
                    <CheckMark checked={filters.labels.includes(l.id)} />
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />
                    <span className="flex-1 truncate">{l.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {ctx.cycles.length > 0 && (
              <CommandGroup heading="Cycle">
                {ctx.cycles.map((c) => (
                  <CommandItem key={c.id} value={`cycle ${c.name}`} onSelect={() => toggle("cycle", c.id)}>
                    <CheckMark checked={filters.cycle.includes(c.id)} />
                    <span className="flex-1 truncate">{c.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {ctx.modules.length > 0 && (
              <CommandGroup heading="Module">
                {ctx.modules.map((m) => (
                  <CommandItem key={m.id} value={`module ${m.name}`} onSelect={() => toggle("module", m.id)}>
                    <CheckMark checked={filters.module.includes(m.id)} />
                    <span className="flex-1 truncate">{m.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            <CommandGroup heading="Échéance">
              {DATE_TOKENS.map((t) => (
                <CommandItem key={t.key} value={`échéance ${t.label}`} onSelect={() => toggle("target_date", t.key)}>
                  <CheckMark checked={filters.target_date.includes(t.key)} />
                  <span className="flex-1">{t.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {count > 0 && (
          <div className="border-t p-2">
            <button
              type="button"
              onClick={() => onChange({ ...EMPTY_FILTERS, query: filters.query })}
              className="w-full rounded px-2 py-1 text-12 text-muted-foreground hover:bg-muted"
            >
              Tout effacer
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Les critères actifs, en toutes lettres sous la barre. C'est ce qui évite le
 * grand classique du board filtré : chercher pendant dix minutes pourquoi un
 * item « a disparu » alors qu'un filtre traîne dans un menu fermé.
 */
function AppliedFilters({
  filters, ctx, onChange,
}: { filters: Filters; ctx: FilterContext; onChange: (f: Filters) => void }) {
  const chips: { key: FilterKey; value: string; label: string; color?: string }[] = [];

  for (const p of filters.priority) {
    chips.push({ key: "priority", value: p, label: PRIORITIES.find((x) => x.key === p)?.label ?? p });
  }
  for (const id of filters.state) {
    const s = ctx.states.find((x) => x.id === id);
    chips.push({ key: "state", value: id, label: s?.name ?? "État", color: s?.color });
  }
  for (const g of filters.state_group) {
    chips.push({ key: "state_group", value: g, label: STATE_GROUPS.find((x) => x.key === g)?.label ?? g });
  }
  for (const id of filters.assignees) {
    chips.push({
      key: "assignees", value: id,
      label: id === "none" ? "Non assigné" : memberName(ctx.members.find((m) => m.user_id === id)),
    });
  }
  for (const id of filters.agents ?? []) {
    chips.push({
      key: "agents", value: id,
      label: id === "none" ? "Sans agent" : ctx.agents?.find((a) => a.id === id)?.name ?? "Agent",
    });
  }
  for (const id of filters.labels) {
    const l = ctx.labels.find((x) => x.id === id);
    chips.push({ key: "labels", value: id, label: id === "none" ? "Sans label" : l?.name ?? "Label", color: l?.color });
  }
  for (const id of filters.cycle) {
    chips.push({ key: "cycle", value: id, label: ctx.cycles.find((c) => c.id === id)?.name ?? "Cycle" });
  }
  for (const id of filters.module) {
    chips.push({ key: "module", value: id, label: ctx.modules.find((m) => m.id === id)?.name ?? "Module" });
  }
  for (const t of filters.target_date) {
    chips.push({ key: "target_date", value: t, label: DATE_TOKENS.find((x) => x.key === t)?.label ?? t });
  }

  if (!chips.length) return null;

  const remove = (key: FilterKey, value: string) => {
    // `?? []` : un filtre enregistré avant l'ajout d'un champ ne le porte pas.
    const list = (filters[key] as string[] | undefined) ?? [];
    onChange({ ...filters, [key]: list.filter((v) => v !== value) } as Filters);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <span
          key={`${c.key}-${c.value}`}
          className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/50 px-2 py-0.5 text-11"
        >
          {c.color && <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.color }} />}
          {c.label}
          <button type="button" onClick={() => remove(c.key, c.value)} className="opacity-60 hover:opacity-100">
            <XIcon className="h-3 w-3" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => onChange({ ...EMPTY_FILTERS, query: filters.query })}
        className="text-11 text-muted-foreground underline-offset-2 hover:underline"
      >
        Tout effacer
      </button>
    </div>
  );
}

// ── Affichage ───────────────────────────────────────────────────────────────

function DisplayMenu({
  display, properties, onDisplay, onProperties, layout,
}: {
  display: DisplayFilters; properties: DisplayProperties;
  onDisplay: (d: DisplayFilters) => void; onProperties: (p: DisplayProperties) => void;
  layout: Layout;
}) {
  const [open, setOpen] = useState(false);

  // Le calendrier et le Gantt ne groupent rien : proposer un « grouper par »
  // qui n'a aucun effet visible ferait douter du reste du menu.
  const supportsGrouping = layout === "list" || layout === "kanban";

  /**
   * Le RÉGLAGE QUI MASQUE, écrit sur le bouton.
   *
   * « Display » ne disait rien de l'état du board. C'est un défaut qui coûte
   * cher : un board réglé sur « Actifs » dans un projet dont tout est en
   * backlog paraît vide, et rien dans la barre n'indique pourquoi. On cherche
   * alors du côté des données, ou l'on recrée un item qui existe déjà.
   *
   * Le bouton porte donc le réglage actif. Il ne montre QUE ce qui écarte des
   * lignes — « Tout » et « sous-tâches visibles » sont l'état normal et
   * n'apprennent rien ; les afficher noierait le signal qu'on cherche à
   * donner. Sans rien à signaler, le bouton reprend son libellé neutre.
   */
  const hidingBits = [
    display.type === "active" ? "Actifs" : display.type === "backlog" ? "Backlog" : null,
    !display.sub_issue ? "Sans sous-tâches" : null,
  ].filter(Boolean) as string[];

  const hiding = hidingBits.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={
            hiding
              ? `Affichage restreint : ${hidingBits.join(" · ")}. Cliquez pour régler.`
              : "Réglages d'affichage"
          }
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-12 transition-colors",
            // Teinté quand il masque : c'est le même signal que la barre de
            // filtres donne déjà quand des critères sont posés, et le board
            // doit dire d'une seule façon « tu ne vois pas tout ».
            hiding
              ? "border-primary/40 bg-primary/10 font-medium text-primary"
              : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <SlidersHorizontalIcon className="h-4 w-4" />
          {hiding ? hidingBits.join(" · ") : "Affichage"}
          <CaretDownIcon className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3 p-3" align="end">
        <Segmented
          label="Afficher"
          value={display.type}
          options={[
            { key: "all", label: "Tout" },
            { key: "active", label: "Actifs" },
            { key: "backlog", label: "Backlog" },
          ]}
          onChange={(v) => onDisplay({ ...display, type: v as DisplayFilters["type"] })}
        />

        {supportsGrouping && (
          <MenuSelect
            label="Grouper par"
            value={display.group_by ?? "none"}
            options={GROUP_BY_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
            onChange={(v) => onDisplay({ ...display, group_by: (v === "none" ? null : v) as GroupBy })}
          />
        )}

        <MenuSelect
          label="Trier par"
          value={display.order_by}
          options={ORDER_BY_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
          onChange={(v) => onDisplay({ ...display, order_by: v as OrderBy })}
        />

        <div className="space-y-1.5">
          <p className="text-11 font-medium text-muted-foreground">Options</p>
          <ToggleRow
            label="Afficher les sous-tâches"
            checked={display.sub_issue}
            onChange={(v) => onDisplay({ ...display, sub_issue: v })}
          />
          {supportsGrouping && (
            <ToggleRow
              label="Afficher les groupes vides"
              checked={display.show_empty_groups}
              onChange={(v) => onDisplay({ ...display, show_empty_groups: v })}
            />
          )}
        </div>

        <div className="space-y-1.5">
          <p className="text-11 font-medium text-tertiary">Propriétés</p>
          {/* Douze bascules côte à côte : sans bordure. Un contour sur chacune
              dessine une grille de cases qu'on voit avant leur contenu, alors
              que ce sont des réglages auxquels on touche rarement. */}
          <div className="flex flex-wrap gap-1">
            {(Object.keys(DISPLAY_PROPERTY_LABELS) as (keyof DisplayProperties)[]).map((k) => (
              <Chip
                key={k}
                active={!!properties[k]}
                onClick={() => onProperties({ ...properties, [k]: !properties[k] })}
              >
                {DISPLAY_PROPERTY_LABELS[k]}
              </Chip>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Segmented({
  label, value, options, onChange,
}: { label: string; value: string; options: { key: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <p className="text-11 font-medium text-muted-foreground">{label}</p>
      <div className="flex h-7 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            className={cn(
              "flex-1 rounded px-2 py-1 text-12 transition-colors",
              value === o.key ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MenuSelect({
  label, value, options, onChange,
}: { label: string; value: string; options: { key: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-11 font-medium text-tertiary">{label}</span>
      {/* Le sélecteur du module, pas celui du système : un `<select>` natif
          ouvre la liste déroulante de l'OS — bande bleue, coins carrés, corps
          du navigateur — qui ne suit ni le thème ni le mode sombre, et qui
          dans un menu clair a l'air d'une fenêtre d'un autre logiciel. */}
      <Select
        size="xs"
        className="w-40"
        value={value}
        onChange={onChange}
        options={options}
      />
    </div>
  );
}

function ToggleRow({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <Checkbox checked={checked} onChange={onChange} label={label} />;
}
