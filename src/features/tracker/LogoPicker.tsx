import { useState } from "react";
import {
  ArrowsClockwiseIcon, BriefcaseIcon, BugIcon, ChartLineUpIcon, ChatCircleIcon,
  CodeIcon, CompassIcon, CpuIcon, CubeIcon, DatabaseIcon, FlagIcon, FlaskIcon,
  GearIcon, GlobeIcon, HeartIcon, LightbulbIcon, LockIcon, MegaphoneIcon,
  PaletteIcon, RocketLaunchIcon, ShieldCheckIcon, SparkleIcon, StackIcon,
  TargetIcon, UsersThreeIcon, WrenchIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Le logo d'un projet, d'une initiative ou d'une page : un emoji OU une icône
 * colorée.
 *
 * Le format est celui de Plane — `{ in_use, emoji: { value }, icon: { name,
 * color } }` — pour que les exports restent lisibles des deux côtés, et parce
 * qu'un champ `in_use` explicite évite d'avoir à deviner laquelle des deux clés
 * fait foi quand les deux sont remplies.
 *
 * Les deux modes ne servent pas la même chose :
 *   · l'EMOJI est arbitraire et coloré, donc il se retient. C'est ce qu'on veut
 *     dans une sidebar de quinze projets aux noms qui commencent tous par
 *     « Refonte… ».
 *   · l'ICÔNE est sobre et se décline dans une couleur choisie. C'est ce qu'on
 *     veut quand les projets forment des familles qu'on souhaite voir d'un coup
 *     — tout ce qui touche à la sécurité en rouge, par exemple.
 */

export interface LogoProps {
  in_use?: "emoji" | "icon";
  emoji?: { value: string };
  icon?: { name: string; color: string };
  [key: string]: unknown;
}

/** Un jeu court, rangé par usage plutôt que par ordre alphabétique : on cherche
 *  « quelque chose qui évoque un chantier », pas un nom précis. */
const EMOJI_GROUPS: { label: string; items: string[] }[] = [
  { label: "Travail", items: ["🚀", "🛠️", "⚙️", "🧱", "📦", "🗂️", "📋", "🧭", "🎯", "🏗️"] },
  { label: "Produit", items: ["💡", "✨", "🎨", "📱", "🖥️", "🧩", "🔍", "📊", "🧪", "🔬"] },
  { label: "Suivi", items: ["🔥", "⚡", "🐞", "🧹", "🔒", "🛡️", "📈", "💰", "⏱️", "🚦"] },
  { label: "Équipe", items: ["🤝", "👥", "🗣️", "📣", "🎓", "🌱", "🏆", "🎉", "☕", "🧠"] },
];

/**
 * Le catalogue d'icônes, indexé par NOM et non par référence : c'est le nom qui
 * est stocké en base, et une table de correspondance explicite évite qu'un
 * renommage d'import casse silencieusement les logos déjà enregistrés.
 */
export const LOGO_ICONS: Record<string, PhosphorIcon> = {
  Briefcase: BriefcaseIcon, Rocket: RocketLaunchIcon, Target: TargetIcon,
  Flag: FlagIcon, Compass: CompassIcon, Stack: StackIcon, Cube: CubeIcon,
  Lightbulb: LightbulbIcon, Sparkle: SparkleIcon, Palette: PaletteIcon,
  Code: CodeIcon, Cpu: CpuIcon, Database: DatabaseIcon, Globe: GlobeIcon,
  Bug: BugIcon, Wrench: WrenchIcon, Gear: GearIcon, Flask: FlaskIcon,
  Shield: ShieldCheckIcon, Lock: LockIcon, ChartLine: ChartLineUpIcon,
  Megaphone: MegaphoneIcon, Chat: ChatCircleIcon, Users: UsersThreeIcon,
  Heart: HeartIcon, Cycle: ArrowsClockwiseIcon,
};

/** Douze teintes, toutes à la même saturation et à la même luminosité : c'est
 *  ce qui garantit qu'aucune ne « saute » à côté des autres dans une liste. */
const ICON_COLORS = [
  "#e34948", "#eb6834", "#eda100", "#a3b81e", "#3e9b4f", "#1baf7a",
  "#0ea5b5", "#2a78d6", "#4a3aa7", "#8b5cf6", "#c026a3", "#e87ba4",
];

export function readEmoji(logo: Record<string, unknown> | null | undefined): string | null {
  const props = logo as LogoProps | undefined;
  if (props?.in_use === "icon") return null;
  return props?.emoji?.value ?? null;
}

export function readIcon(
  logo: Record<string, unknown> | null | undefined,
): { Icon: PhosphorIcon; color: string } | null {
  const props = logo as LogoProps | undefined;
  if (props?.in_use !== "icon" || !props.icon) return null;
  // L'index peut ne rien renvoyer : un nom enregistré autrefois peut avoir
  // disparu du catalogue, et le typage de `Record` ne le dit pas.
  const Icon = LOGO_ICONS[props.icon.name] as PhosphorIcon | undefined;
  return Icon ? { Icon, color: props.icon.color } : null;
}

/**
 * L'icône de repli d'un projet sans logo choisi.
 *
 * Elle est TIRÉE du catalogue, pas composée de ses initiales : deux lettres
 * pâles devant un nom se lisent comme « l'icône n'a pas chargé », alors que
 * c'est l'état normal d'un projet qu'on vient de créer. Une vraie icône donne
 * au projet une silhouette qu'on retrouve du coin de l'œil.
 *
 * Le choix dérive de l'identifiant, donc il est STABLE d'une session à l'autre
 * et d'un poste à l'autre — c'est ce qui le rend repérable. Deux projets
 * peuvent tomber sur la même icône ; ils tombent alors rarement sur la même
 * teinte, et de toute façon un logo choisi à la main les départage.
 */
function fallbackLogo(seed: string): { Icon: PhosphorIcon; color: string } {
  let hash = 0;
  for (const ch of seed || "?") hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;

  const names = Object.keys(LOGO_ICONS);
  return {
    Icon: LOGO_ICONS[names[hash % names.length]],
    // La couleur vient d'un autre pas du même hachage : la dériver du même
    // reste ferait varier l'icône et la teinte ensemble, et deux projets
    // voisins dans l'alphabet se ressembleraient trait pour trait.
    color: ICON_COLORS[Math.floor(hash / names.length) % ICON_COLORS.length],
  };
}

/**
 * Le rendu d'un logo, à utiliser partout où un projet s'affiche.
 *
 * Sans logo choisi, il retombe sur une icône du catalogue — jamais sur un carré
 * vide, qui se lirait comme un chargement raté.
 */
export function ProjectLogo({
  logo, fallback, size = 16, className,
}: {
  logo: Record<string, unknown> | null | undefined;
  /** L'identifiant du projet, pour le repli. */
  fallback?: string;
  size?: number;
  className?: string;
}) {
  const emoji = readEmoji(logo);
  const icon = readIcon(logo);

  if (icon) {
    return (
      <icon.Icon
        className={cn("shrink-0", className)}
        style={{ width: size, height: size, color: icon.color }}
        weight="fill"
      />
    );
  }

  if (emoji) {
    return (
      <span className={cn("shrink-0 leading-none", className)} style={{ fontSize: size }}>
        {emoji}
      </span>
    );
  }

  const repli = fallbackLogo(fallback ?? "?");
  return (
    <repli.Icon
      className={cn("shrink-0", className)}
      style={{ width: size, height: size, color: repli.color }}
      weight="fill"
    />
  );
}

export function LogoPicker({
  value, onChange, size = 28, fallback, className,
}: {
  value: Record<string, unknown> | null | undefined;
  onChange: (logo: LogoProps) => void;
  size?: number;
  fallback?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"emoji" | "icon">(
    (value as LogoProps | undefined)?.in_use === "icon" ? "icon" : "emoji",
  );
  const [color, setColor] = useState(
    (value as LogoProps | undefined)?.icon?.color ?? ICON_COLORS[7],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Choisir un emoji ou une icône"
          style={{ width: size, height: size }}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md border border-border/70 hover:bg-muted",
            className,
          )}
        >
          <ProjectLogo logo={value} fallback={fallback} size={size * 0.6} />
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-2" align="start">
        <nav className="mb-2 inline-flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
          {(["emoji", "icon"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "flex h-6 items-center rounded-md px-2.5 text-12 transition-all",
                tab === t
                  ? "border border-border bg-card font-medium text-foreground shadow-raised-100"
                  : "border border-transparent text-tertiary hover:text-foreground",
              )}
            >
              {t === "emoji" ? "Emoji" : "Icône"}
            </button>
          ))}
        </nav>

        {tab === "emoji" ? (
          <div className="max-h-64 space-y-2.5 overflow-y-auto">
            {EMOJI_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="pb-1 text-10 uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </p>
                <div className="flex flex-wrap gap-0.5">
                  {group.items.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        onChange({ in_use: "emoji", emoji: { value: emoji } });
                        setOpen(false);
                      }}
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-lg text-18 leading-none hover:bg-muted",
                        readEmoji(value) === emoji && "bg-primary/15",
                      )}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2.5">
            {/* La couleur se choisit AVANT l'icône : c'est elle qui reste
                visible quand la forme se réduit à seize pixels. */}
            <div className="flex flex-wrap gap-1">
              {ICON_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Couleur ${c}`}
                  className="h-6 w-6 rounded-full transition-transform"
                  style={{
                    background: c,
                    boxShadow: color === c ? `0 0 0 2px hsl(var(--background)), 0 0 0 4px ${c}` : undefined,
                  }}
                />
              ))}
            </div>

            <div className="grid max-h-52 grid-cols-8 gap-0.5 overflow-y-auto">
              {Object.entries(LOGO_ICONS).map(([name, Icon]) => (
                <button
                  key={name}
                  type="button"
                  title={name}
                  onClick={() => {
                    onChange({ in_use: "icon", icon: { name, color } });
                    setOpen(false);
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-muted"
                >
                  <Icon className="h-[18px] w-[18px]" style={{ color }} weight="fill" />
                </button>
              ))}
            </div>
          </div>
        )}

        {(readEmoji(value) || readIcon(value)) && (
          <button
            type="button"
            onClick={() => { onChange({}); setOpen(false); }}
            className="mt-2 w-full rounded-lg border border-border py-1.5 text-11 text-muted-foreground hover:bg-muted"
          >
            Retirer
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
