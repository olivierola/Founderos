import { forwardRef, useMemo, useState, type ReactNode } from "react";
import {
  CalendarBlankIcon, CaretDownIcon, CheckIcon, CircleDashedIcon, CircleHalfIcon,
  CircleIcon, ProhibitIcon, TagIcon, UserIcon, XIcon,
  CellSignalFullIcon, CellSignalHighIcon, CellSignalMediumIcon, CellSignalLowIcon,
  CheckCircleIcon,
} from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Calendar } from "@/components/ui/calendar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  PRIORITIES, type Member, type PjCycle, type PjLabel, type PjModule, type PjState,
  type Priority, type StateGroup,
} from "./model";

/**
 * Les contrôles d'édition d'un work item.
 *
 * Ils sont écrits une fois et posés partout — ligne de liste, carte de kanban,
 * cellule de tableur, panneau de détail. C'est ce qui fait qu'on change un état
 * de la même façon quel que soit l'endroit, et c'est exactement ce que Plane
 * obtient en réutilisant ses dropdowns : l'utilisateur n'apprend le geste
 * qu'une fois.
 *
 * Tous suivent la même forme : un déclencheur discret qui affiche la valeur, un
 * popover de sélection cherchable, et un `onChange` qui écrit tout de suite.
 * Aucun bouton « Enregistrer » : sur un board, la validation explicite est ce
 * qui fait perdre les modifications.
 */

// ── Habillage commun ────────────────────────────────────────────────────────

/**
 * L'habillage commun des sélecteurs.
 *
 * Il TRANSMET sa ref et les propriétés qu'on lui passe, et ce n'est pas un
 * détail de style : les huit sélecteurs du module (état, priorité, assignés,
 * agents, labels, dates, cycle, module) l'utilisent comme cible d'un
 * `PopoverTrigger asChild`. Radix clone alors l'enfant en lui injectant son
 * gestionnaire de clic, son ancre de positionnement et ses attributs ARIA — un
 * composant qui ignore ce qu'on lui passe les jette tous, et le bouton devient
 * inerte tout en ayant l'air normal.
 *
 * C'est exactement la panne qu'on a eue : « Début » et « Fin » ne faisaient
 * rien, et la cause n'était ni dans le calendrier ni dans le formulaire, mais
 * ici, dans une signature qui ne laissait rien passer.
 */
export const PickerTrigger = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; children: ReactNode }
>(function PickerTrigger({ children, className, active, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2 text-12 transition-colors",
        active
          ? "bg-muted text-foreground"
          : "bg-muted/40 text-tertiary hover:bg-muted hover:text-foreground",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

// ── État ────────────────────────────────────────────────────────────────────

/**
 * L'icône vient du GROUPE, jamais de la couleur seule : deux états peuvent
 * partager une teinte, et un daltonien doit pouvoir lire « terminé » sans la
 * distinguer de « annulé ».
 */
export function StateIcon({ group, color, className }: { group: StateGroup; color?: string; className?: string }) {
  const style = color ? { color } : undefined;
  const cls = cn("h-4 w-4 shrink-0", className);
  switch (group) {
    case "backlog": return <CircleDashedIcon className={cls} style={style} />;
    case "unstarted": return <CircleIcon className={cls} style={style} />;
    case "started": return <CircleHalfIcon className={cls} style={style} weight="fill" />;
    case "completed": return <CheckCircleIcon className={cls} style={style} weight="fill" />;
    case "cancelled": return <ProhibitIcon className={cls} style={style} />;
  }
}

export function StatePicker({
  states, value, onChange, compact,
}: {
  states: PjState[]; value: string | null;
  onChange: (id: string) => void; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = states.find((s) => s.id === value) ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerTrigger active={!!current} title="État">
          {current
            ? <StateIcon group={current.group} color={current.color} />
            : <CircleDashedIcon className="h-4 w-4" />}
          {!compact && <span className="truncate">{current?.name ?? "État"}</span>}
        </PickerTrigger>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Chercher un état…" />
          <CommandList>
            <CommandEmpty>Aucun état.</CommandEmpty>
            <CommandGroup>
              {states.map((s) => (
                <CommandItem key={s.id} value={s.name} onSelect={() => { onChange(s.id); setOpen(false); }}>
                  <StateIcon group={s.group} color={s.color} />
                  <span className="flex-1 truncate">{s.name}</span>
                  {s.id === value && <CheckIcon className="h-4 w-4" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── Priorité ────────────────────────────────────────────────────────────────

/**
 * Les barres de signal de Plane : elles se lisent en périphérie de vision, ce
 * qu'une pastille de couleur ne permet pas.
 */
export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const cls = cn("h-4 w-4 shrink-0", className);
  const color = PRIORITIES.find((p) => p.key === priority)?.color;
  const style = { color };
  switch (priority) {
    case "urgent": return <CellSignalFullIcon className={cls} style={style} weight="fill" />;
    case "high": return <CellSignalHighIcon className={cls} style={style} />;
    case "medium": return <CellSignalMediumIcon className={cls} style={style} />;
    case "low": return <CellSignalLowIcon className={cls} style={style} />;
    default: return <CellSignalLowIcon className={cn(cls, "opacity-40")} />;
  }
}

export function PriorityPicker({
  value, onChange, compact,
}: { value: Priority; onChange: (p: Priority) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const current = PRIORITIES.find((p) => p.key === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerTrigger active={value !== "none"} title="Priorité">
          <PriorityIcon priority={value} />
          {!compact && <span>{current?.label ?? "Priorité"}</span>}
        </PickerTrigger>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-0" align="start">
        <Command>
          <CommandList>
            <CommandGroup>
              {PRIORITIES.map((p) => (
                <CommandItem key={p.key} value={p.label} onSelect={() => { onChange(p.key); setOpen(false); }}>
                  <PriorityIcon priority={p.key} />
                  <span className="flex-1">{p.label}</span>
                  {p.key === value && <CheckIcon className="h-4 w-4" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── Personnes ───────────────────────────────────────────────────────────────

export function memberName(m: Member | undefined, fallback = "Inconnu"): string {
  return m?.full_name || m?.email || fallback;
}

export function MemberAvatar({ member, size = 20 }: { member: Member | undefined; size?: number }) {
  const name = memberName(member, "?");
  const initials = name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
  return (
    <Avatar style={{ width: size, height: size }} className="shrink-0">
      <AvatarFallback className="text-10">{initials}</AvatarFallback>
    </Avatar>
  );
}

/**
 * Les avatars s'empilent au-delà de trois et le reste devient « +N ». Une ligne
 * de liste qui s'élargit avec le nombre d'assignés casse l'alignement de toute
 * la colonne.
 */
export function AssigneeStack({ ids, members, max = 3 }: { ids: string[]; members: Member[]; max?: number }) {
  if (!ids.length) return <UserIcon className="h-4 w-4 text-muted-foreground" />;
  const shown = ids.slice(0, max);
  const rest = ids.length - shown.length;
  return (
    <div className="flex items-center -space-x-1.5">
      {shown.map((id) => (
        <div key={id} className="rounded-full ring-1 ring-background">
          <MemberAvatar member={members.find((m) => m.user_id === id)} />
        </div>
      ))}
      {rest > 0 && (
        <span className="ml-2.5 text-11 text-muted-foreground">+{rest}</span>
      )}
    </div>
  );
}

export function AssigneePicker({
  members, value, onChange, compact,
}: { members: Member[]; value: string[]; onChange: (ids: string[]) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerTrigger active={value.length > 0} title="Assignés">
          <AssigneeStack ids={value} members={members} />
          {!compact && !value.length && <span>Assignés</span>}
        </PickerTrigger>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Chercher une personne…" />
          <CommandList>
            <CommandEmpty>
              <PickerHint>
                Personne à afficher. Les membres s&apos;invitent depuis
                Administration → Membres.
              </PickerHint>
            </CommandEmpty>
            <CommandGroup>
              {members.map((m) => (
                <CommandItem key={m.user_id} value={memberName(m)} onSelect={() => toggle(m.user_id)}>
                  <MemberAvatar member={m} />
                  <span className="flex-1 truncate">{memberName(m)}</span>
                  {value.includes(m.user_id) && <CheckIcon className="h-4 w-4" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── Labels ──────────────────────────────────────────────────────────────────

export function LabelChip({ label, onRemove }: { label: PjLabel; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-11"
      style={{ borderColor: `${label.color}66`, color: label.color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: label.color }} />
      {label.name}
      {onRemove && (
        <button type="button" onClick={onRemove} className="opacity-60 hover:opacity-100">
          <XIcon className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

/**
 * Douze teintes pour les labels créés à la volée.
 *
 * Tirées dans l'ordre plutôt qu'au hasard : deux labels créés à la suite
 * doivent se distinguer, et un tirage aléatoire donne régulièrement deux verts
 * voisins qu'on ne différencie plus dans une liste.
 */
export const LABEL_COLORS = [
  "#e34948", "#eb6834", "#eda100", "#a3b81e", "#3e9b4f", "#1baf7a",
  "#0ea5b5", "#2a78d6", "#4a3aa7", "#8b5cf6", "#c026a3", "#e87ba4",
];

export function LabelPicker({
  labels, value, onChange, onCreate, compact,
}: {
  labels: PjLabel[]; value: string[]; onChange: (ids: string[]) => void;
  /** Créer un label sans quitter le champ : sinon on va dans les réglages, on
   *  perd le fil, et on finit par ne pas mettre de label du tout. */
  onCreate?: (name: string) => Promise<PjLabel | null>;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  const exact = labels.some((l) => l.name.toLowerCase() === search.trim().toLowerCase());
  const selected = labels.filter((l) => value.includes(l.id));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerTrigger active={value.length > 0} title="Labels">
          <TagIcon className="h-4 w-4" />
          {!compact && (selected.length
            ? <span className="truncate">{selected.map((l) => l.name).join(", ")}</span>
            : <span>Labels</span>)}
          {compact && selected.length > 0 && <span>{selected.length}</span>}
        </PickerTrigger>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command shouldFilter>
          <CommandInput placeholder="Chercher un label…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>
              {onCreate && search.trim() && !exact ? (
                <button
                  type="button"
                  className="w-full px-2 py-1.5 text-left text-14 hover:bg-muted"
                  onClick={async () => {
                    const created = await onCreate(search.trim());
                    if (created) onChange([...value, created.id]);
                    setSearch("");
                  }}
                >
                  Créer « {search.trim()} »
                </button>
              ) : onCreate ? (
                // Sans label ET sans recherche : on dit quoi faire plutôt que
                // de constater le vide. « Aucun label » devant une liste où
                // l'on vient précisément pour en ajouter un est une impasse.
                <span className="block px-2 py-2 text-12 text-tertiary">
                  Tapez un nom pour créer votre premier label.
                </span>
              ) : "Aucun label."}
            </CommandEmpty>
            <CommandGroup>
              {labels.map((l) => (
                <CommandItem key={l.id} value={l.name} onSelect={() => toggle(l.id)}>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />
                  <span className="flex-1 truncate">{l.name}</span>
                  {value.includes(l.id) && <CheckIcon className="h-4 w-4" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── Dates ───────────────────────────────────────────────────────────────────

export function formatDate(value: string | null): string {
  if (!value) return "";
  return new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("fr-FR", {
    day: "numeric", month: "short",
  });
}

/**
 * Le temps écoulé, en clair : « il y a 13 heures ».
 *
 * Sur une liste de récents ou de liens, c'est ce qui informe — pas la date
 * absolue. « 4 sept. » oblige à calculer soi-même pour savoir si c'est vieux ;
 * « il y a 4 heures » répond directement à la question qu'on se pose, qui est
 * « est-ce encore d'actualité ».
 *
 * Au-delà d'un mois on rebascule sur la date : « il y a 7 semaines » demande
 * autant d'effort que la date elle-même, sans sa précision.
 */
export function formatRelative(value: string | null): string {
  if (!value) return "";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "";

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "à l'instant";

  const rtf = new Intl.RelativeTimeFormat("fr-FR", { numeric: "auto" });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 31) return rtf.format(-days, "day");

  return new Date(value).toLocaleDateString("fr-FR", {
    day: "numeric", month: "short", year: "numeric",
  });
}

/** Une échéance dépassée se signale, sinon elle ne sert à rien. */
export function isOverdue(target: string | null, completedAt: string | null): boolean {
  if (!target || completedAt) return false;
  return target.slice(0, 10) < new Date().toISOString().slice(0, 10);
}

export function DatePicker({
  value, onChange, placeholder = "Date", compact, min,
}: {
  value: string | null; onChange: (v: string | null) => void;
  placeholder?: string; compact?: boolean; min?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const overdue = isOverdue(value, null);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerTrigger active={!!value} title={placeholder} className={cn(overdue && "text-red-600")}>
          <CalendarBlankIcon className="h-4 w-4" />
          {(!compact || value) && <span>{value ? formatDate(value) : placeholder}</span>}
        </PickerTrigger>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value ? new Date(`${value.slice(0, 10)}T00:00:00`) : undefined}
          disabled={min ? { before: new Date(`${min.slice(0, 10)}T00:00:00`) } : undefined}
          onSelect={(d) => {
            // Le jour local, pas l'ISO UTC : à Paris en été, toISOString() sur
            // un 1er du mois sélectionné à minuit renvoie la veille.
            onChange(d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : null);
            setOpen(false);
          }}
        />
        {value && (
          <div className="border-t p-2">
            <button
              type="button"
              className="w-full rounded px-2 py-1 text-12 text-muted-foreground hover:bg-muted"
              onClick={() => { onChange(null); setOpen(false); }}
            >
              Effacer
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Cycle / module ──────────────────────────────────────────────────────────

/** Le vide d'un sélecteur : ce qu'il faut faire, pas ce qui manque. */
function PickerHint({ children }: { children: ReactNode }) {
  return <p className="px-3 py-3 text-11 leading-snug text-tertiary">{children}</p>;
}

export function CyclePicker({
  cycles, value, onChange, compact,
}: { cycles: PjCycle[]; value: string | null; onChange: (id: string | null) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const current = cycles.find((c) => c.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerTrigger active={!!current} title="Cycle">
          <CaretDownIcon className="h-3 w-3" />
          {!compact && <span className="truncate">{current?.name ?? "Cycle"}</span>}
        </PickerTrigger>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Chercher un cycle…" />
          <CommandList>
            <CommandEmpty>
              <PickerHint>
                Aucun cycle dans ce projet. Ils se créent dans l&apos;onglet
                Cycles — un cycle borne une itération par ses dates.
              </PickerHint>
            </CommandEmpty>
            <CommandGroup>
              <CommandItem value="__none__" onSelect={() => { onChange(null); setOpen(false); }}>
                <span className="flex-1 text-muted-foreground">Hors cycle</span>
                {!value && <CheckIcon className="h-4 w-4" />}
              </CommandItem>
              {cycles.map((c) => (
                <CommandItem key={c.id} value={c.name} onSelect={() => { onChange(c.id); setOpen(false); }}>
                  <span className="flex-1 truncate">{c.name}</span>
                  {c.id === value && <CheckIcon className="h-4 w-4" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function ModulePicker({
  modules, value, onChange, compact,
}: { modules: PjModule[]; value: string[]; onChange: (ids: string[]) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  const selected = modules.filter((m) => value.includes(m.id));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PickerTrigger active={value.length > 0} title="Modules">
          <CaretDownIcon className="h-3 w-3" />
          {!compact && (selected.length
            ? <span className="truncate">{selected.map((m) => m.name).join(", ")}</span>
            : <span>Modules</span>)}
        </PickerTrigger>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Chercher un module…" />
          <CommandList>
            <CommandEmpty>
              <PickerHint>
                Aucun module dans ce projet. Ils se créent dans l&apos;onglet
                Modules — un module regroupe le travail d&apos;un chantier.
              </PickerHint>
            </CommandEmpty>
            <CommandGroup>
              {modules.map((m) => (
                <CommandItem key={m.id} value={m.name} onSelect={() => toggle(m.id)}>
                  <span className="flex-1 truncate">{m.name}</span>
                  {value.includes(m.id) && <CheckIcon className="h-4 w-4" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── Référence ───────────────────────────────────────────────────────────────

/** PROJ-42. C'est ce que les gens copient dans une conversation. */
export function IssueKey({ identifier, sequenceId, className }: {
  identifier: string; sequenceId: number; className?: string;
}) {
  return (
    <span className={cn("shrink-0 font-mono text-11 text-muted-foreground", className)}>
      {identifier}-{sequenceId}
    </span>
  );
}

/** Les compteurs partagés par la liste, le kanban et le tableur. */
export function useIssueLookup(states: PjState[], labels: PjLabel[]) {
  return useMemo(() => ({
    stateById: new Map(states.map((s) => [s.id, s])),
    labelById: new Map(labels.map((l) => [l.id, l])),
  }), [states, labels]);
}
