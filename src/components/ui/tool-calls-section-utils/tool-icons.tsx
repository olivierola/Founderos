// Category → icon, and tool name → label, for tool-calls-section.tsx.
//
// The point of the icon is recognition: when an agent calls HubSpot the row
// should show the HubSpot logo, not a generic wrench. So a category that names
// a connector resolves through BrandLogo (the same real logos the connector
// cards use); everything else falls back to a Phosphor glyph per tool family.
import type { CSSProperties, ReactNode } from "react";
import {
  WrenchIcon as Wrench,
  GlobeIcon as Globe,
  MagnifyingGlassIcon as Search,
  FileTextIcon as FileText,
  TerminalWindowIcon as TerminalSquare,
  PackageIcon as Package,
  BrainIcon as Brain,
  TargetIcon as Target,
  ChatsIcon as MessagesSquare,
  TreeViewIcon as ListTree,
  EnvelopeSimpleIcon as Mail,
  DatabaseIcon as Database,
  PlugIcon as Plug,
  SparkleIcon as Sparkles,
  ShieldCheckIcon as ShieldCheck,
  FlaskIcon as FlaskConical,
  UsersIcon as Users,
  GraduationCapIcon as GraduationCap,
} from "@phosphor-icons/react";
import { BrandLogo } from "@/components/BrandLogo";

/** Families that have no brand behind them — an internal capability. */
const FAMILY_ICON: Record<string, typeof Wrench> = {
  web: Globe,
  search: Search,
  files: FileText,
  execution: TerminalSquare,
  artifacts: Package,
  memory: Brain,
  missions: Target,
  handoff: Users,
  messaging: MessagesSquare,
  planning: ListTree,
  training: GraduationCap,
  email: Mail,
  data: Database,
  security: ShieldCheck,
  testing: FlaskConical,
  generation: Sparkles,
  integration: Plug,
  general: Wrench,
};

/**
 * Human label for a raw tool name. Strips the prefixes the runtime adds
 * (`use_` for connectors, `mcp_<server>_` for MCP tools, `runner_`/`sandbox_`
 * for the hybrid execution worlds) so the row reads as the action, not as the
 * plumbing that carried it.
 */
export function formatToolName(toolName: string): string {
  let t = toolName;
  if (t.startsWith("mcp_")) {
    const rest = t.slice(4).split("_");
    t = rest.slice(1).join("_") || rest.join("_");
  }
  if (t.startsWith("runner_")) t = t.slice(7);
  else if (t.startsWith("sandbox_")) t = t.slice(8);
  if (t.startsWith("use_")) t = t.slice(4);
  const words = t.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Wrapper that gives every icon the same plate, so the stacked row lines up. */
function Plate({ children, size }: { children: ReactNode; size: number }) {
  return (
    <span
      className="flex items-center justify-center rounded-lg bg-muted/70 text-muted-foreground"
      style={{ width: size + 11, height: size + 11 }}
    >
      {children}
    </span>
  );
}

/**
 * Icon for a tool category. `iconUrl` wins when the integration ships one;
 * otherwise a connector slug resolves to its real logo and anything else to a
 * family glyph. Returns null only when the category is empty, which lets the
 * caller apply its own fallback.
 */
export function getToolCategoryIcon(
  category: string,
  style?: CSSProperties & { width?: number; height?: number },
  iconUrl?: string,
): ReactNode {
  if (!category) return null;
  const size = Number(style?.width ?? 21);

  if (iconUrl) {
    return (
      <Plate size={size}>
        <img
          src={iconUrl}
          alt=""
          loading="lazy"
          className="rounded-sm object-contain"
          style={{ width: size - 4, height: size - 4 }}
        />
      </Plate>
    );
  }

  const key = category.toLowerCase();
  const Family = FAMILY_ICON[key];
  if (Family) {
    return (
      <Plate size={size}>
        <Family style={{ width: size - 6, height: size - 6 }} />
      </Plate>
    );
  }

  // Not a known family → treat it as a connector slug. BrandLogo already
  // degrades to a plug glyph when it recognises nothing, so this is safe for
  // unknown MCP servers too.
  return (
    <Plate size={size}>
      {/* BrandLogo sizes itself from className, and this size is dynamic — so
          it fills a box the plate sizes instead. */}
      <span style={{ width: size - 5, height: size - 5 }} className="flex items-center justify-center">
        <BrandLogo slug={key} className="h-full w-full object-contain" />
      </span>
    </Plate>
  );
}
