import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsInSimpleIcon, ArrowsOutSimpleIcon, SidebarSimpleIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { IssueKey, StateIcon, type LayoutProps } from "./shared";
import { formatDate } from "../pickers";
import type { PjIssue } from "../model";

/**
 * Le Gantt : une barre par item, de sa date de début à son échéance.
 *
 * Deux partis pris hérités de Plane :
 *  - un item sans AUCUNE date n'a pas de barre. On le laisse quand même dans la
 *    colonne de gauche, sinon on ne peut pas lui en donner une ;
 *  - un item qui n'a qu'une seule des deux dates reçoit une barre d'un jour à
 *    cette date, plutôt que d'être masqué : c'est ce qui permet de l'attraper
 *    et de l'étirer.
 *
 * Le déplacement et le redimensionnement se font au pixel puis sont convertis
 * en jours à la fin du geste : convertir en continu ferait sauter la barre d'un
 * jour à l'autre pendant qu'on la tient.
 */

/**
 * Les crans de zoom, en largeur d'un jour.
 *
 * Ce ne sont pas trois tailles d'une même vue : ce sont trois QUESTIONS.
 * « Semaine » sert à caler des journées les unes contre les autres ; « Mois »
 * sert à voir un cycle en entier ; « Trimestre » sert à voir si deux chantiers
 * se chevauchent. Un curseur continu forcerait à chercher le bon niveau à
 * chaque fois, là où trois crans nommés le donnent d'un clic.
 */
const ZOOMS = [
  // Quatre crans, du plus fin au plus large. « Jour » sert au travail à la
  // journée — on y pose et déplace des barres d'un ou deux jours, ce qu'un
  // cran plus large rend impossible à viser à la souris. Les autres répondent
  // à d'autres questions : caler une semaine, voir un cycle entier, repérer
  // deux chantiers qui se chevauchent.
  //
  // 40 px au cran « semaine » et non 28 : la case porte un numéro ET l'initiale
  // du jour, et à 28 px les deux se chevauchaient — « 16 Me » se lisait « M16 ».
  { key: "day", label: "Jour", dayWidth: 88 },
  { key: "week", label: "Semaine", dayWidth: 40 },
  { key: "month", label: "Mois", dayWidth: 14 },
  { key: "quarter", label: "Trimestre", dayWidth: 5 },
] as const;

type Zoom = (typeof ZOOMS)[number]["key"];

/**
 * Le numéro de semaine ISO.
 *
 * ISO et non « la semaine du 1er janvier » : c'est la numérotation qu'emploient
 * les équipes qui parlent en semaines (« on livre S36 »), et se tromper d'un
 * cran rendrait l'en-tête inutilisable pour la seule chose à quoi il sert.
 * L'algorithme est celui de la norme — on se cale sur le jeudi de la semaine,
 * qui appartient toujours à la bonne année.
 */
function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Dimanche vaut 0 en JS et 7 en ISO ; sans ce report, la dernière semaine de
  // l'année tombe systématiquement d'un cran.
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
}

/** Les initiales de jour, sur une lettre ou deux, comme dans l'original. */
const WEEKDAY = ["D", "L", "Ma", "Me", "J", "V", "S"];
const ROW_HEIGHT = 34;

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseDay(s: string): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00`);
}

function daysBetween(a: string, b: string): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);
}

function addDays(s: string, n: number): string {
  const d = parseDay(s);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

interface Span { start: string; end: string }

/** Ce que la barre d'un item couvre, une fois les dates manquantes comblées. */
function spanOf(i: PjIssue): Span | null {
  if (i.start_date && i.target_date) return { start: i.start_date.slice(0, 10), end: i.target_date.slice(0, 10) };
  if (i.target_date) return { start: i.target_date.slice(0, 10), end: i.target_date.slice(0, 10) };
  if (i.start_date) return { start: i.start_date.slice(0, 10), end: i.start_date.slice(0, 10) };
  return null;
}

type DragMode = { issue: PjIssue; kind: "move" | "start" | "end"; originX: number } | null;

export function GanttLayout(props: LayoutProps) {
  const { groups, states, project, onOpen, onPatch } = props;
  const [drag, setDrag] = useState<DragMode>(null);
  const [deltaDays, setDeltaDays] = useState(0);
  const [zoom, setZoom] = useState<Zoom>("week");
  // La colonne des titres se replie : sur un trimestre, ses 360 px mangent un
  // quart de l'écran alors qu'on ne lit plus les noms — on suit des barres.
  const [names, setNames] = useState(true);
  const [full, setFull] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const DAY_WIDTH = ZOOMS.find((z) => z.key === zoom)!.dayWidth;

  /**
   * La largeur disponible, mesurée.
   *
   * Sans elle, la frise s'arrête à la dernière date connue : sur un projet qui
   * ne porte qu'un item, la grille faisait mille pixels et laissait les deux
   * tiers de l'écran vides — c'est ce qui donnait l'impression d'un affichage
   * cassé plutôt que d'un projet peu rempli. On étend donc la fenêtre jusqu'au
   * bord, et le calendrier continue au-delà des items, ce qui est exactement ce
   * qu'on veut pour y poser du travail à venir.
   */
  const [viewport, setViewport] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setViewport(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * Ramène AUJOURD'HUI au centre.
   *
   * C'est le seul bouton de navigation dont un gantt a vraiment besoin : sur un
   * projet étalé sur six mois, on se perd en deux glissements, et retrouver la
   * date du jour à la main demande de lire les en-têtes de mois un par un.
   */
  const scrollToToday = () => {
    const el = scroller.current;
    if (!el) return;
    const offset = daysBetween(origin, isoDay(new Date())) * DAY_WIDTH;
    el.scrollTo({ left: Math.max(0, offset - el.clientWidth / 2), behavior: "smooth" });
  };

  // Le tableau aplatit les groupes, comme le tableur : une barre par item.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: PjIssue[] = [];
    for (const g of groups) for (const i of g.issues) {
      if (!seen.has(i.id)) { seen.add(i.id); out.push(i); }
    }
    return out;
  }, [groups]);

  // La fenêtre temporelle est déduite des items, avec une marge d'une semaine
  // de chaque côté pour pouvoir étirer une barre au-delà de son extrémité.
  //
  // Elle ne descend jamais sous la largeur de l'ÉCRAN : `days` dit combien de
  // jours il faut pour aller jusqu'au bord, arrondis à la semaine entière pour
  // ne pas laisser une bande hebdomadaire tronquée à droite.
  const days = Math.max(30, Math.ceil(viewport / DAY_WIDTH / 7) * 7);

  const { origin, totalDays, weeks } = useMemo(() => {
    const spans = rows.map(spanOf).filter(Boolean) as Span[];
    const today = isoDay(new Date());
    const min = spans.length ? spans.reduce((m, s) => (s.start < m ? s.start : m), spans[0].start) : today;
    const max = spans.length ? spans.reduce((m, s) => (s.end > m ? s.end : m), spans[0].end) : today;
    const from = addDays(min, -7);
    const to = addDays(max, 7);
    const total = Math.max(daysBetween(from, to) + 1, days);

    // Les bandes du haut suivent les SEMAINES, pas les mois.
    //
    // C'est ce qui manquait, et la différence est de fond : une bande mensuelle
    // dit dans quel mois on est, ce qu'on voit déjà aux dates ; une bande
    // hebdomadaire dit où commence et où finit la semaine, qui est l'unité
    // dans laquelle une équipe planifie. Le mois reste écrit dans le libellé —
    // et une semaine à cheval en porte DEUX, ce qui la signale comme telle.
    const marks: { key: string; days: number; label: string; week: number }[] = [];
    for (let d = 0; d < total; d++) {
      const day = parseDay(addDays(from, d));
      const week = isoWeek(day);
      const key = `${day.getFullYear()}-S${week}`;
      const month = day.toLocaleDateString("fr-FR", { month: "short", year: "numeric" });
      const last = marks[marks.length - 1];
      if (last && last.key === key) {
        last.days += 1;
        // Le mois change au milieu de la semaine : on l'écrit en intervalle
        // plutôt que de garder celui du lundi, qui serait faux à droite.
        if (!last.label.endsWith(month)) last.label = `${last.label.split(" – ")[0]} – ${month}`;
      } else {
        marks.push({ key, days: 1, label: month, week });
      }
    }
    return { origin: from, totalDays: total, weeks: marks };
  }, [rows, days]);

  const finishDrag = () => {
    if (drag && deltaDays !== 0) {
      const span = spanOf(drag.issue);
      if (span) {
        if (drag.kind === "move") {
          onPatch(drag.issue.id, {
            start_date: addDays(span.start, deltaDays),
            target_date: addDays(span.end, deltaDays),
          });
        } else if (drag.kind === "start") {
          const next = addDays(span.start, deltaDays);
          // Une barre ne peut pas finir avant de commencer : on bute sur la
          // date de fin plutôt que d'écrire un intervalle négatif.
          if (next <= span.end) onPatch(drag.issue.id, { start_date: next });
        } else {
          const next = addDays(span.end, deltaDays);
          if (next >= span.start) onPatch(drag.issue.id, { target_date: next });
        }
      }
    }
    setDrag(null);
    setDeltaDays(0);
  };

  const todayOffset = daysBetween(origin, isoDay(new Date()));

  // Échap sort du plein écran. C'est le réflexe, et sans lui la seule sortie
  // est un bouton qu'on ne retrouve pas toujours sur un écran devenu large.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  return (
    <div
      className={cn(
        "flex flex-col",
        // Le plein écran sort du gabarit de la page plutôt que de l'étirer :
        // un gantt reste illisible tant qu'il partage la largeur avec une
        // barre latérale, et c'est la seule vue du module dont la valeur tient
        // à la place qu'on lui donne.
        full ? "fixed inset-0 z-50 bg-background" : "h-full",
      )}
    >
      {/* Le compteur à gauche, les crans à droite : la même disposition que
          partout ailleurs dans le module, pour que la barre d'un layout ne
          demande pas de réapprendre où regarder. */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <span className="text-11 text-tertiary">
          {rows.length} work item{rows.length > 1 ? "s" : ""}
        </span>
        <div className="flex-1" />

        <div className="flex h-7 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
          {ZOOMS.map((z) => (
            <button
              key={z.key}
              type="button"
              onClick={() => setZoom(z.key)}
              className={cn(
                "flex h-6 items-center rounded-md border border-transparent px-2.5 text-11 transition-all",
                z.key === zoom
                  ? "border-border bg-card font-medium text-foreground shadow-raised-100"
                  : "text-tertiary hover:text-foreground",
              )}
            >
              {z.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={scrollToToday}
          className="flex h-7 items-center rounded-md border border-border px-2.5 text-11 text-secondary hover:bg-muted hover:text-foreground"
        >
          Aujourd&apos;hui
        </button>

        <button
          type="button"
          title={names ? "Masquer les titres" : "Afficher les titres"}
          aria-pressed={!names}
          onClick={() => setNames((v) => !v)}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-tertiary hover:bg-muted hover:text-foreground"
        >
          <SidebarSimpleIcon className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          title={full ? "Quitter le plein écran" : "Plein écran"}
          onClick={() => setFull((v) => !v)}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-tertiary hover:bg-muted hover:text-foreground"
        >
          {full
            ? <ArrowsInSimpleIcon className="h-3.5 w-3.5" />
            : <ArrowsOutSimpleIcon className="h-3.5 w-3.5" />}
        </button>
      </div>

    <div
      className="flex min-h-0 flex-1"
      onMouseMove={(e) => {
        if (!drag) return;
        setDeltaDays(Math.round((e.clientX - drag.originX) / DAY_WIDTH));
      }}
      onMouseUp={finishDrag}
      onMouseLeave={finishDrag}
    >
      {/* Colonne des titres, figée. */}
      <div
        className={cn(
          "shrink-0 overflow-hidden border-r border-border transition-[width] duration-standard ease-smooth",
          // 260 px suffisent à lire une référence et un titre tronqué ; les
          // 360 d'avant laissaient du blanc au milieu de la colonne et
          // rétrécissaient d'autant la frise, qui est le sujet.
          names ? "w-[260px]" : "w-0",
        )}
      >
        {/* Deux colonnes annoncées, comme dans l'original : le titre et la
            DURÉE. Cette dernière est la seule donnée qu'un gantt ajoute à une
            liste, et ne pas l'écrire oblige à la déduire en comptant les
            cases — ce qu'un diagramme est censé éviter. */}
        <div className="flex h-[52px] items-end border-b border-border bg-background px-3 pb-1.5">
          <span className="min-w-0 flex-1 text-12 font-medium text-secondary">Work items</span>
          <span className="shrink-0 text-12 font-medium text-tertiary">Durée</span>
        </div>

        {rows.map((i) => {
          const state = states.find((s) => s.id === i.state_id);
          const span = spanOf(i);
          const days = span ? daysBetween(span.start, span.end) + 1 : null;
          return (
            <button
              key={i.id}
              type="button"
              onClick={() => onOpen(i)}
              style={{ height: ROW_HEIGHT }}
              className="flex w-full items-center gap-2 border-b border-border/40 px-3 text-left hover:bg-muted/50"
            >
              {state && <StateIcon group={state.group} color={state.color} className="h-3.5 w-3.5" />}
              <IssueKey identifier={project.identifier} sequenceId={i.sequence_id} />
              <span className="min-w-0 flex-1 truncate text-13">{i.name}</span>
              {/* Sans dates, un tiret plutôt que rien : la colonne reste
                  alignée et dit que la donnée manque au lieu de laisser croire
                  à un défaut d'affichage. */}
              <span className="shrink-0 text-11 tabular-nums text-tertiary">
                {days ? `${days} j` : "—"}
              </span>
            </button>
          );
        })}
      </div>

      {/* Grille temporelle. */}
      <div ref={scroller} className="flex-1 overflow-auto">
        <div style={{ width: totalDays * DAY_WIDTH, minWidth: "100%" }} className="relative">
          <div className="sticky top-0 z-10 bg-background">
            <div className="flex border-b border-border/60">
              {weeks.map((w) => (
                <div
                  key={w.key}
                  style={{ width: w.days * DAY_WIDTH }}
                  className="flex shrink-0 items-baseline gap-2 border-r border-border px-2 py-1.5"
                >
                  <span className="min-w-0 truncate text-11 font-medium capitalize text-secondary">
                    {w.label}
                  </span>
                  <span className="ml-auto shrink-0 text-10 text-placeholder">S{w.week}</span>
                </div>
              ))}
            </div>

            <div className="flex border-b border-border">
              {Array.from({ length: totalDays }, (_, d) => {
                const day = parseDay(addDays(origin, d));
                const weekend = day.getDay() === 0 || day.getDay() === 6;
                const monday = day.getDay() === 1;
                const today = d === todayOffset;
                return (
                  <div
                    key={d}
                    style={{ width: DAY_WIDTH }}
                    className={cn(
                      "flex shrink-0 items-center justify-center gap-1 py-1 text-10",
                      // Le filet de SEMAINE est net, celui du jour presque
                      // invisible : c'est ce qui laisse lire les blocs de sept
                      // jours d'un coup d'œil au lieu d'une grille uniforme où
                      // il faut compter.
                      monday ? "border-l border-border" : "border-l border-border/20",
                      weekend && "bg-muted/30",
                    )}
                  >
                    {/* Le jour EN COURS porte une pastille pleine, pas
                        seulement un trait rouge dans la grille : sur une vue
                        au trimestre, le trait se perd et la pastille reste
                        repérable dans l'en-tête, qui est figé. */}
                    <span
                      className={cn(
                        "tabular-nums",
                        today
                          ? "flex h-4 min-w-4 items-center justify-center rounded bg-primary px-1 font-medium text-primary-foreground"
                          : "text-secondary",
                      )}
                    >
                      {day.getDate()}
                    </span>
                    {/* L'initiale du jour disparaît quand la colonne devient
                        trop étroite : au trimestre elle se réduirait à une
                        bouillie d'un pixel de large. */}
                    {DAY_WIDTH >= 34 && (
                      <span className="text-placeholder">{WEEKDAY[day.getDay()]}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Les colonnes de fond, tirées jusqu'en bas.
              Sans elles, la grille s'arrête à la dernière ligne et la moitié
              basse du diagramme devient une surface vide où l'œil n'a plus
              aucun repère pour situer une date. Elles sont posées SOUS les
              barres et ne captent pas la souris, pour ne pas gêner le glisser. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 top-[52px] flex">
            {Array.from({ length: totalDays }, (_, d) => {
              const day = parseDay(addDays(origin, d));
              const weekend = day.getDay() === 0 || day.getDay() === 6;
              const monday = day.getDay() === 1;
              return (
                <div
                  key={d}
                  style={{ width: DAY_WIDTH }}
                  className={cn(
                    "shrink-0",
                    monday ? "border-l border-border/70" : "border-l border-border/15",
                    weekend && "bg-muted/20",
                  )}
                />
              );
            })}
          </div>

          {/* Le repère du jour : sans lui, on ne sait pas si une barre est en
              retard ou à venir. */}
          {todayOffset >= 0 && todayOffset < totalDays && (
            <div
              className="pointer-events-none absolute bottom-0 top-[52px] z-[5] w-px bg-primary/60"
              style={{ left: todayOffset * DAY_WIDTH + DAY_WIDTH / 2 }}
            />
          )}

          {rows.map((i) => {
            const span = spanOf(i);
            const state = states.find((s) => s.id === i.state_id);
            const moving = drag?.issue.id === i.id;
            const shift = moving && drag.kind === "move" ? deltaDays : 0;
            const growStart = moving && drag.kind === "start" ? deltaDays : 0;
            const growEnd = moving && drag.kind === "end" ? deltaDays : 0;

            return (
              <div key={i.id} style={{ height: ROW_HEIGHT }} className="group/row relative border-b border-border/30">
                {/* Sans dates, on pose une amorce au niveau d'aujourd'hui
                    plutôt que de laisser la ligne vide : c'est ce qui permet
                    d'attraper l'item et de lui donner des dates en le tirant,
                    au lieu d'avoir à ouvrir sa fiche. */}
                {!span && todayOffset >= 0 && (
                  <button
                    type="button"
                    onClick={() => onOpen(i)}
                    title="Sans dates — ouvrir pour en donner"
                    className="absolute top-2.5 z-[6] h-[12px] rounded border border-dashed border-border opacity-0 transition-opacity group-hover/row:opacity-100"
                    style={{ left: todayOffset * DAY_WIDTH, width: DAY_WIDTH * 3 }}
                  />
                )}
                {span && (() => {
                  const left = (daysBetween(origin, span.start) + shift + growStart) * DAY_WIDTH;
                  const width = Math.max((daysBetween(span.start, span.end) + 1 - growStart + growEnd) * DAY_WIDTH, DAY_WIDTH);
                  return (
                    <div
                      className={cn(
                        "absolute top-1.5 z-[6] flex h-[24px] items-center rounded-md shadow-raised-100",
                        // Pendant le glisser, la barre passe au-dessus de tout
                        // et perd sa transition : une barre qui « rattrape » le
                        // curseur avec 200 ms de retard donne l'impression que
                        // le geste ne prend pas.
                        moving ? "z-20 ring-2 ring-primary/50" : "transition-[left,width] duration-quick ease-smooth",
                      )}
                      style={{
                        left,
                        width,
                        // Le remplissage porte la couleur de l'ÉTAT, à faible
                        // opacité, et la bordure la même à pleine intensité :
                        // une barre pleine et saturée sur douze lignes fait un
                        // mur de couleur où plus rien ne se distingue.
                        background: `${state?.color ?? "#6b7280"}2e`,
                        borderLeft: `3px solid ${state?.color ?? "#6b7280"}`,
                        borderTop: `1px solid ${state?.color ?? "#6b7280"}66`,
                        borderRight: `1px solid ${state?.color ?? "#6b7280"}66`,
                        borderBottom: `1px solid ${state?.color ?? "#6b7280"}66`,
                      }}
                      title={`${i.name} · ${formatDate(span.start)} → ${formatDate(span.end)}`}
                    >
                      {/* Les poignées ne se montrent qu'au survol de la LIGNE :
                          visibles en permanence, elles ajoutent deux traits par
                          barre et transforment le diagramme en peigne. */}
                      <span
                        className="h-full w-2 shrink-0 cursor-ew-resize rounded-l opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-black/10"
                        onMouseDown={(e) => { e.stopPropagation(); setDrag({ issue: i, kind: "start", originX: e.clientX }); }}
                      />
                      <span
                        className="min-w-0 flex-1 cursor-grab truncate px-1 text-11 font-medium"
                        onMouseDown={(e) => setDrag({ issue: i, kind: "move", originX: e.clientX })}
                        onClick={() => !moving && onOpen(i)}
                      >
                        {i.name}
                      </span>
                      <span
                        className="h-full w-2 shrink-0 cursor-ew-resize rounded-r opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-black/10"
                        onMouseDown={(e) => { e.stopPropagation(); setDrag({ issue: i, kind: "end", originX: e.clientX }); }}
                      />
                    </div>
                  );
                })()}
              </div>
            );
          })}

          {!rows.length && (
            <p className="px-4 py-8 text-13 text-tertiary">
              Aucun work item à placer sur la frise.
            </p>
          )}
        </div>
      </div>
    </div>
    </div>
  );
}
