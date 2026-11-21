// L'habillage des ressources du registre, partagé par l'onglet Pools et par le
// panneau des pools d'un agent : une icône par source (le logo de l'app
// Composio quand le catalogue le donne, l'avatar de l'agent pour l'A2A), une
// teinte par famille, et la barre qui montre de quoi un pool est fait.
//
// Les logos et les avatars viennent de requêtes que le dashboard fait déjà
// (catalogue Composio, agents du projet) : React Query les partage, rien n'est
// chargé deux fois.
import { useMemo } from "react";
import {
  PuzzlePieceIcon, DatabaseIcon, LightningIcon, ShieldCheckIcon, FlowArrowIcon, RobotIcon,
  HardDrivesIcon, PlugsConnectedIcon, PlugIcon, WrenchIcon, SparkleIcon, type Icon,
} from "@phosphor-icons/react";
import { AgentIdentity } from "@/components/AgentIdentity";
import { BrandLogo } from "@/components/BrandLogo";
import { useComposioToolkits } from "@/features/service-dashboards/useToolkits";
import { cn } from "@/lib/utils";
import { FAMILIES, familyOf, useProjectAgents, type Family, type PoolAgent, type RegistryItem, type RegistrySource } from "./model";

export const FAMILY_META: Record<Family, { icon: Icon; tile: string; bar: string }> = {
  tools: { icon: PuzzlePieceIcon, tile: "bg-sky-500/10 text-sky-600 dark:text-sky-400", bar: "bg-sky-500" },
  knowledge: { icon: DatabaseIcon, tile: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", bar: "bg-emerald-500" },
  skills: { icon: LightningIcon, tile: "bg-violet-500/10 text-violet-600 dark:text-violet-400", bar: "bg-violet-500" },
  guardrails: { icon: ShieldCheckIcon, tile: "bg-amber-500/10 text-amber-600 dark:text-amber-400", bar: "bg-amber-500" },
  workflows: { icon: FlowArrowIcon, tile: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400", bar: "bg-indigo-500" },
  agents: { icon: RobotIcon, tile: "bg-rose-500/10 text-rose-600 dark:text-rose-400", bar: "bg-rose-500" },
};

const SOURCE_ICON: Record<RegistrySource, Icon> = {
  mcp: HardDrivesIcon,
  composio: PlugsConnectedIcon,
  app_connector: PlugIcon,
  custom_connector: WrenchIcon,
  builtin: SparkleIcon,
  rag: DatabaseIcon,
  skill: LightningIcon,
  guardrail: ShieldCheckIcon,
  workflow: FlowArrowIcon,
  agent: RobotIcon,
};

export interface Visuals {
  logoOf: (r: RegistryItem) => string | null;
  agentOf: (r: RegistryItem) => PoolAgent | null;
  agents: PoolAgent[];
}

/** Ce qu'il faut pour dessiner les ressources d'un projet. */
export function useVisuals(projectId: string | null): Visuals {
  const { data: toolkits } = useComposioToolkits();
  const { data: agents } = useProjectAgents(projectId);
  return useMemo(() => {
    const logos = new Map((toolkits ?? []).map((t) => [t.slug.toLowerCase(), t.logo]));
    const byId = new Map((agents ?? []).map((a) => [a.id, a]));
    return {
      logoOf: (r) => {
        if (r.source !== "composio") return null;
        const slug = String(r.metadata?.toolkit ?? r.item_key ?? "").toLowerCase();
        return logos.get(slug) ?? null;
      },
      agentOf: (r) => (r.source === "agent" ? byId.get(r.source_id) ?? null : null),
      agents: agents ?? [],
    };
  }, [toolkits, agents]);
}

/** L'icône d'une ressource : logo, avatar, ou pictogramme de sa source teinté
 *  à la couleur de sa famille. Un outil prend celle de sa source parente. */
export function ResourceIcon({ r, parent, visuals, size = "md" }: {
  r: RegistryItem; parent?: RegistryItem; visuals: Visuals; size?: "sm" | "md";
}) {
  const box = size === "sm" ? "h-6 w-6" : "h-8 w-8";
  const glyph = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  const agent = visuals.agentOf(r);
  if (agent) {
    return <AgentIdentity url={agent.avatar_url} seed={agent.name} size={size === "sm" ? 24 : 32} rounded="rounded-full" interactive={false} />;
  }
  // Un connecteur maison : le logo de la marque (BrandLogo), lui ou sa source.
  const provider = r.source === "app_connector" ? String(r.metadata?.provider ?? parent?.metadata?.provider ?? "") : "";
  if (provider) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background", box)}>
        <BrandLogo slug={provider} className={size === "sm" ? "h-3.5 w-3.5" : "h-[18px] w-[18px]"} />
      </span>
    );
  }
  const logo = visuals.logoOf(r) ?? (parent ? visuals.logoOf(parent) : null);
  if (logo) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background", box)}>
        <img src={logo} alt="" loading="lazy" className={cn("rounded-sm object-contain", size === "sm" ? "h-3.5 w-3.5" : "h-[18px] w-[18px]")} />
      </span>
    );
  }
  const Glyph = SOURCE_ICON[r.source];
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-lg", box, FAMILY_META[familyOf(r)].tile)}>
      <Glyph weight="duotone" className={glyph} />
    </span>
  );
}

/** La pastille d'une famille, en tête d'une section. */
export function FamilyTile({ family, className }: { family: Family; className?: string }) {
  const F = FAMILY_META[family];
  return (
    <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", F.tile, className)}>
      <F.icon weight="duotone" className="h-4 w-4" />
    </span>
  );
}

/** Combien de ressources de chaque famille : la barre et ses légendes. */
export function countFamilies(items: Array<RegistryItem | null | undefined>): Map<Family, number> {
  const m = new Map<Family, number>();
  for (const r of items) if (r) m.set(familyOf(r), (m.get(familyOf(r)) ?? 0) + 1);
  return m;
}

export function CompositionBar({ counts, className }: { counts: Map<Family, number>; className?: string }) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return (
    <div className={cn("flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted", className)}>
      {total > 0 && FAMILIES.filter((f) => counts.get(f.key)).map((f) => (
        <span
          key={f.key}
          title={`${counts.get(f.key)} ${f.label.toLowerCase()}`}
          className={cn("h-full first:rounded-l-full last:rounded-r-full", FAMILY_META[f.key].bar)}
          style={{ width: `${(100 * (counts.get(f.key) ?? 0)) / total}%` }}
        />
      ))}
    </div>
  );
}

export function FamilyCounts({ counts, className }: { counts: Map<Family, number>; className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground", className)}>
      {FAMILIES.filter((f) => counts.get(f.key)).map((f) => {
        const F = FAMILY_META[f.key];
        return (
          <span key={f.key} className="inline-flex items-center gap-1">
            <span className={cn("h-1.5 w-1.5 rounded-full", F.bar)} />
            <span className="font-medium text-foreground">{counts.get(f.key)}</span> {f.label.toLowerCase()}
          </span>
        );
      })}
    </div>
  );
}

/** Les avatars des agents d'un pool, en pile. */
export function AgentStack({ ids, visuals, max = 4 }: { ids: string[]; visuals: Visuals; max?: number }) {
  const known = ids.map((id) => visuals.agents.find((a) => a.id === id)).filter((a): a is PoolAgent => !!a);
  if (!known.length) return null;
  return (
    <span className="flex items-center -space-x-2">
      {known.slice(0, max).map((a) => (
        <span key={a.id} title={a.name} className="rounded-full ring-2 ring-card">
          <AgentIdentity url={a.avatar_url} seed={a.name} size={24} rounded="rounded-full" interactive={false} />
        </span>
      ))}
      {known.length > max && (
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-card">
          +{known.length - max}
        </span>
      )}
    </span>
  );
}
