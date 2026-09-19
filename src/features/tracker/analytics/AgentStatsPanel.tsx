import { useEffect, useMemo } from "react";
import {
  ArrowSquareOutIcon, CheckCircleIcon, ClockIcon, RobotIcon, XCircleIcon, XIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { useCategorical } from "@/features/crm/overview/vizPalette";
import type { HqView } from "@/features/dashboard/hq/model";
import { formatRelative } from "../pickers";

/**
 * La fiche statistique d'un agent, ouverte depuis la table.
 *
 * Elle répond à la question qu'on se pose en voyant une ligne sortir du lot —
 * « pourquoi celui-là ? » — sans quitter la page. C'est la raison d'être d'un
 * panneau plutôt que d'une navigation : la table reste derrière, la ligne
 * d'origine reste marquée, et on referme pour comparer avec la suivante.
 *
 * Elle ne recalcule RIEN. Tout vient de la vue déjà bâtie pour la page, donc
 * des mêmes filtres — période, projet, demandeur. Refaire les agrégats ici
 * donnerait le défaut classique du panneau de détail : des chiffres qui ne
 * s'additionnent pas à ceux du tableau qui l'a ouvert.
 *
 * ── Le soin apporté à la surface ────────────────────────────────────────────
 *
 * Trois choses, et une seule intention : que le panneau se lise comme un OBJET
 * posé sur la page, pas comme un second écran ouvert par-dessus.
 *
 *   · LE SCRIM EST UN VOILE LÉGER, sans flou. La table doit rester LISIBLE
 *     derrière : c'est elle qu'on vient comparer, et un arrière-plan brouillé
 *     oblige à refermer le panneau pour relire la ligne d'à côté.
 *   · L'EN-TÊTE PORTE LA COULEUR DE L'AGENT, en dégradé très dilué. C'est le
 *     seul endroit où elle apparaît en grand, et c'est ce qui fait qu'on
 *     reconnaît de qui on parle avant d'avoir lu le nom.
 *   · LES CHIFFRES SONT EN GRAND ET LES LIBELLÉS EN PETITES CAPITALES. Sur une
 *     fiche qu'on ouvre pour un coup d'œil, la hiérarchie doit être tranchée :
 *     la valeur d'abord, ce qu'elle mesure ensuite.
 */

export function AgentStatsPanel({
  agentId, view, onClose, onOpenAgent,
}: {
  agentId: string;
  view: HqView;
  onClose: () => void;
  /** Vers la vraie fiche de l'agent — configuration, conversations, missions. */
  onOpenAgent: (id: string) => void;
}) {
  const palette = useCategorical();

  /**
   * Le fond ne défile plus tant que le panneau est ouvert.
   *
   * C'est la contrepartie du passage en `fixed` : un tiroir qui flotte
   * au-dessus d'une page défilante laisse la molette agir sur ce qui est
   * DERRIÈRE lui. On tourne la molette au-dessus du voile, et c'est le tableau
   * qui bouge — on croit le panneau cassé alors qu'il n'a simplement rien à
   * faire défiler à cet endroit.
   *
   * Le verrou est posé sur `document.body` et retiré au démontage, y compris si
   * le composant disparaît autrement que par sa croix : laisser la page bloquée
   * après la fermeture serait bien pire que le défaut qu'on corrige.
   */
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, []);

  const stats = view.productivity.find((p) => p.agent.id === agentId);
  const agent = stats?.agent ?? view.agentById.get(agentId) ?? null;

  const runs = useMemo(
    () => view.runs.filter((r) => r.agent_id === agentId).slice().reverse(),
    [view.runs, agentId],
  );

  const deliverables = useMemo(
    () => view.deliverables.filter((d) => d.agent_id === agentId).slice(0, 8),
    [view.deliverables, agentId],
  );

  // Les outils de CET agent, du plus employé au moins. La matrice les porte
  // déjà : agent × outil, comptés sur la même fenêtre que le reste.
  const tools = useMemo(() => {
    const row = view.toolUsage.matrix.get(agentId);
    if (!row) return [];
    return [...row.entries()]
      .map(([tool, calls]) => ({ tool, calls }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 10);
  }, [view.toolUsage.matrix, agentId]);

  // L'activité de l'agent sur la grille de la page. La courbe ne porte pas de
  // valeur lisible et n'en a pas besoin : elle dit la FORME — un agent qui
  // tourne tous les jours et un agent réveillé deux fois se distinguent d'un
  // coup d'œil, ce qu'aucun total ne montre.
  const spark = useMemo(
    () => view.bucket(runs, (r) => r.created_at),
    [view, runs],
  );

  const loop = view.loopHealth.perAgent.find((l) => l.agentId === agentId) ?? null;
  const pending = view.approvals.filter((a) => a.agent_id === agentId && a.status === "pending");
  const maxToolCalls = Math.max(1, ...tools.map((t) => t.calls));
  const accent = agent?.accent_color || "#4b7fd6";
  const failed = (stats?.runs ?? 0) - (stats?.succeeded ?? 0);

  if (!agent) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-foreground/10 animate-in fade-in duration-200"
        onClick={onClose}
        aria-hidden
      />

      <aside
        className={cn(
          "absolute inset-y-0 right-0 flex w-full flex-col overflow-hidden bg-card md:w-[680px]",
          "border-l border-border shadow-[0_0_0_1px_hsl(var(--border)/0.4),-24px_0_60px_-24px_rgb(0_0_0/0.35)]",
          "animate-in slide-in-from-right-4 fade-in duration-300 ease-out",
        )}
      >
        {/* L'en-tête : la seule surface colorée de la fiche. Le dégradé s'éteint
            vers le bas pour que le contenu reparte sur le fond de la carte —
            une bande colorée franche ferait bandeau publicitaire. */}
        <header
          className="relative shrink-0 border-b border-border px-6 pb-5 pt-5"
          style={{ background: `linear-gradient(160deg, ${accent}1f 0%, ${accent}08 45%, transparent 100%)` }}
        >
          <div className="flex items-start gap-3.5">
            <span
              className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-18 shadow-raised-100"
              style={{ background: `${accent}26`, boxShadow: `inset 0 0 0 1px ${accent}40` }}
            >
              {agent.avatar_emoji
                ? <span>{agent.avatar_emoji}</span>
                : <RobotIcon className="h-5 w-5" style={{ color: accent }} />}
            </span>

            <div className="min-w-0 flex-1 pt-0.5">
              <h3 className="truncate text-18 font-semibold tracking-tight">{agent.name}</h3>
              {agent.description && (
                <p className="mt-0.5 line-clamp-2 text-12 leading-snug text-muted-foreground">
                  {agent.description}
                </p>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <HeaderButton title="Ouvrir la fiche de l'agent" onClick={() => onOpenAgent(agent.id)}>
                <ArrowSquareOutIcon className="h-4 w-4" />
              </HeaderButton>
              <HeaderButton title="Fermer" onClick={onClose}>
                <XIcon className="h-4 w-4" />
              </HeaderButton>
            </div>
          </div>

          {spark.some((v) => v > 0) && (
            <Sparkline values={spark} color={accent} className="mt-4" />
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {/* Les quatre chiffres qui décident si l'on creuse. Séparés par des
              filets d'un demi-pixel et non par des cartes : quatre cartes dans
              un panneau de 680 px feraient quatre boîtes dans une boîte. */}
          <div className="grid grid-cols-2 divide-x divide-y divide-border/60 border-b border-border sm:grid-cols-4 sm:divide-y-0">
            <Tile label="Exécutions" value={String(stats?.runs ?? 0)} />
            <Tile
              label="Réussite"
              value={stats?.successRate == null ? "—" : `${Math.round(stats.successRate)} %`}
              tone={stats?.successRate != null && stats.successRate < 60 ? "danger" : undefined}
            />
            <Tile label="Coût" value={money(stats?.totalCost ?? 0)} />
            <Tile label="Livrables" value={String(stats?.deliverables ?? 0)} />
          </div>

          <div className="space-y-7 px-6 py-6">
            {pending.length > 0 && (
              <p className="flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-12 text-amber-700 dark:text-amber-500">
                <ClockIcon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <strong className="font-medium">{pending.length} action(s)</strong> attendent votre validation.
                </span>
              </p>
            )}

            <Section title="Détail">
              <Row label="Coût moyen par exécution" value={money(stats?.avgCost ?? 0)} />
              <Row label="Durée moyenne" value={duration(stats?.avgDurationSec ?? null)} />
              <Row label="Actions" value={String(stats?.totalActions ?? 0)} />
              <Row label="Réussies" value={String(stats?.succeeded ?? 0)} />
              <Row label="Échouées" value={String(failed)} tone={failed > 0 ? "danger" : undefined} />
            </Section>

            {tools.length > 0 && (
              <Section title="Outils employés">
                {/* Des barres et non des nombres seuls : ce qu'on cherche ici
                    n'est pas « combien d'appels » mais « à quoi cet agent passe
                    son temps », et une proportion se voit, elle ne se lit pas. */}
                <div className="space-y-2 pt-2">
                  {tools.map((t, i) => (
                    <div key={t.tool} className="flex items-center gap-3">
                      <span className="w-44 shrink-0 truncate font-mono text-11" title={t.tool}>
                        {t.tool}
                      </span>
                      <span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
                          style={{
                            width: `${(t.calls / maxToolCalls) * 100}%`,
                            background: palette[i % palette.length],
                          }}
                        />
                      </span>
                      <span className="w-10 shrink-0 text-right text-11 tabular-nums text-muted-foreground">
                        {t.calls}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {loop && loop.decisions > 0 && (
              <Section title="Boucle de raisonnement">
                <Row label="Décisions" value={String(loop.decisions)} />
                <Row label="Replanifications" value={String(loop.replans)} tone={loop.replans > 0 ? "warn" : undefined} />
                <Row label="Abandons" value={String(loop.aborts)} tone={loop.aborts > 0 ? "danger" : undefined} />
                <Row label="Boucles détectées" value={String(loop.loopsDetected)} tone={loop.loopsDetected > 0 ? "danger" : undefined} />
                <Row label="Stagnations" value={String(loop.stagnation)} />
              </Section>
            )}

            <Section title="Dernières exécutions" hint={runs.length > 12 ? `12 sur ${runs.length}` : undefined}>
              {runs.length ? (
                <ul className="pt-1">
                  {runs.slice(0, 12).map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50"
                    >
                      <RunDot status={r.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-12">
                          {r.label || r.run_kind || "Exécution"}
                        </span>
                        {r.error_message && (
                          <span className="block truncate text-10 text-red-600" title={r.error_message}>
                            {r.error_message}
                          </span>
                        )}
                      </span>
                      {r.cost_usd > 0 && (
                        <span className="shrink-0 text-11 tabular-nums text-muted-foreground">
                          {money(r.cost_usd)}
                        </span>
                      )}
                      <span className="w-16 shrink-0 text-right text-11 text-placeholder">
                        {formatRelative(r.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-12 text-muted-foreground">Aucune sur cette période.</p>
              )}
            </Section>

            {deliverables.length > 0 && (
              <Section title="Livrables produits">
                <ul className="pt-1">
                  {deliverables.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50"
                    >
                      <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-10 text-muted-foreground">
                        {d.kind}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-12">{d.name}</span>
                      <span className="shrink-0 text-11 text-placeholder">
                        {formatRelative(d.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

// ── Pièces ──────────────────────────────────────────────────────────────────

/**
 * La courbe d'activité de l'en-tête.
 *
 * Une aire et non des barres : à cette taille, des barres d'un pixel de large
 * se lisent comme du bruit. L'aire donne une silhouette, qui est tout ce qu'on
 * demande à un graphe de trois centimètres.
 */
function Sparkline({
  values, color, className,
}: { values: number[]; color: string; className?: string }) {
  const max = Math.max(1, ...values);
  const w = 100;
  const h = 24;
  const step = values.length > 1 ? w / (values.length - 1) : w;

  const points = values.map((v, i) => `${i * step},${h - (v / max) * h}`);
  const line = `M${points.join(" L")}`;
  const area = `${line} L${w},${h} L0,${h} Z`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("h-6 w-full", className)}
      aria-hidden
    >
      <path d={area} fill={color} fillOpacity={0.14} />
      <path d={line} fill="none" stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function HeaderButton({
  title, onClick, children,
}: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-card hover:text-foreground"
    >
      {children}
    </button>
  );
}

function money(v: number): string {
  if (!v) return "$0";
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

function duration(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="px-4 py-3.5">
      <p className="text-10 font-medium uppercase tracking-wider text-tertiary">{label}</p>
      <p className={cn(
        "pt-1 text-20 font-semibold tabular-nums tracking-tight",
        tone === "danger" && "text-red-600",
      )}>
        {value}
      </p>
    </div>
  );
}

function Section({
  title, hint, children,
}: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline gap-2">
        <h4 className="text-11 font-medium uppercase tracking-wider text-tertiary">{title}</h4>
        {hint && <span className="text-10 text-placeholder">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Row({
  label, value, tone,
}: { label: string; value: string; tone?: "warn" | "danger" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 py-2 last:border-0">
      <span className="text-12 text-muted-foreground">{label}</span>
      <span className={cn(
        "text-13 font-medium tabular-nums",
        tone === "warn" && "text-amber-600",
        tone === "danger" && "text-red-600",
      )}>
        {value}
      </span>
    </div>
  );
}

function RunDot({ status }: { status: string }) {
  if (status === "succeeded") return <CheckCircleIcon weight="fill" className="h-4 w-4 shrink-0 text-emerald-600" />;
  if (status === "failed") return <XCircleIcon weight="fill" className="h-4 w-4 shrink-0 text-red-600" />;
  return <ClockIcon className="h-4 w-4 shrink-0 text-amber-600" />;
}
