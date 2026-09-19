import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  SparkleIcon as Sparkles,
  XIcon as X,
  CheckIcon as Check,
  WrenchIcon as Wrench,
  ShieldCheckIcon as ShieldCheck,
  CalendarDotsIcon as CalendarClock,
  ArrowLeftIcon as ArrowLeft,
  ArrowRightIcon as ArrowRight,
  CircleNotchIcon as Loader2,
  PlusIcon as Plus,
  CaretRightIcon as ChevronRight,
  PlugIcon as Plug,
  WarningIcon as AlertTriangle,
  ArrowSquareOutIcon as ExternalLink,
  MagnifyingGlassIcon as Search,
  PaletteIcon as Palette,
  MagicWandIcon as Wand2,
} from "@phosphor-icons/react";
import { callEdge } from "@/lib/edge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useProjectConnectors } from "@/hooks/useConnectors";
import {
  AGENT_TEMPLATES, STUDIO_LABELS, templateAvatar,
  type AgentTemplate, type AgentCategory, type AutonomyLevel, type TemplateTool,
} from "./agentTemplates";
import type { TemplateOverrides } from "./instantiateTemplate";
import { AgentAvatar, AvatarPicker } from "./AvatarPicker";
import { Icon3D } from "./icons3d";
import { CONNECTOR_ACTION_GROUPS, connectorActionProvider } from "./connectorActionProviders";
import { ToolkitCard, synthToolkit, type ComposioToolkit } from "@/features/integrations/ComposioCatalog";

const ACCENTS = ["#2F2FE4", "#7c3aed", "#db2777", "#e11d48", "#ea580c", "#16a34a", "#0891b2", "#475569"];
const AUTONOMY: { key: AutonomyLevel; label: string; desc: string }[] = [
  { key: "advisor", label: "Advisor", desc: "Proposes only — never acts on its own." },
  { key: "assisted", label: "Assisted", desc: "Acts, but sensitive tools need approval." },
  { key: "autopilot", label: "Autopilot", desc: "Acts freely within its guardrails." },
];

export function TemplateDrawer({
  open, onClose, onActivate,
}: {
  open: boolean;
  onClose: () => void;
  onActivate: (template: AgentTemplate, overrides: TemplateOverrides) => Promise<void>;
}) {
  const [selected, setSelected] = useState<AgentTemplate | null>(null);

  function close() {
    setSelected(null);
    onClose();
  }

  // Render via a portal on <body> so the fixed positioning is relative to the
  // viewport (escapes the padded <main> / any positioned ancestor) — the drawer
  // truly spans the full height with no gap at the top.
  return createPortal(
    <>
      {/* Scrim — dim only, no blur. */}
      <div
        className={cn(
          "fixed inset-0 z-[60] bg-black/30 transition-opacity",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={close}
      />
      {/* Right drawer — floating rounded panel, anchored right with a gap. */}
      <aside
        className={cn(
          "fixed right-4 top-4 bottom-4 z-[70] flex w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-border bg-background shadow-2xl transition-transform duration-300 lg:max-w-4xl",
          open ? "translate-x-0" : "translate-x-[calc(100%+1.5rem)]",
        )}
      >
        {selected ? (
          <ConfigStepper
            template={selected}
            onBack={() => setSelected(null)}
            onClose={close}
            onActivate={onActivate}
          />
        ) : (
          <BrowseView onClose={close} onSelect={setSelected} />
        )}
      </aside>
    </>,
    document.body,
  );
}

// ── Browse: filter + grid ────────────────────────────────────────────────────
function BrowseView({ onClose, onSelect }: { onClose: () => void; onSelect: (t: AgentTemplate) => void }) {
  const [cat, setCat] = useState<AgentCategory | "All">("All");
  const [query, setQuery] = useState("");
  const cats = useMemo(() => {
    const order: AgentCategory[] = [];
    for (const t of AGENT_TEMPLATES) if (!order.includes(t.category)) order.push(t.category);
    return order;
  }, []);
  const countByCat = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of AGENT_TEMPLATES) m.set(t.category, (m.get(t.category) ?? 0) + 1);
    return m;
  }, []);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return AGENT_TEMPLATES.filter((t) =>
      (cat === "All" || t.category === cat) &&
      (!q || t.name.toLowerCase().includes(q) || t.tagline.toLowerCase().includes(q)));
  }, [cat, query]);

  return (
    <>
      <header className="flex items-start justify-between gap-3 p-4">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="text-base font-semibold">Agent templates</h2>
            <span className="text-xs text-muted-foreground">· {AGENT_TEMPLATES.length} ready-to-run</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Pick a template, configure it, then add it to your team.</p>
        </div>
        <button onClick={onClose} className="rounded-full p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
          <X className="h-5 w-5" />
        </button>
      </header>

      <GenerateFromRequest onGenerated={onSelect} />

      {/* Toolbar — search + a category dropdown (was a long wrapping chip row). */}
      <div className="flex items-center gap-2 px-4 pb-3">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un template…" className="rounded-full pl-10" />
        </div>
        <Select value={cat} onValueChange={(v) => setCat(v as AgentCategory | "All")}>
          <SelectTrigger className="w-52 shrink-0 rounded-full"><SelectValue /></SelectTrigger>
          <SelectContent className="z-[80] max-h-72 rounded-2xl">
            <SelectItem value="All">Toutes les catégories · {AGENT_TEMPLATES.length}</SelectItem>
            {cats.map((c) => (
              <SelectItem key={c} value={c}>{c} · {countByCat.get(c) ?? 0}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {visible.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
            <Search className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">Aucun template pour « {query} ».</p>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {visible.map((t) => (
            <button key={t.key} onClick={() => onSelect(t)}
              className={cn(
                "group flex flex-col rounded-2xl border p-4 text-left transition-colors",
                // Studio agents own an engine (vibe code / testing / simulations)
                // and produce session artifacts — the animated border is what
                // makes them recognisable at a glance in the grid.
                t.studio
                  ? "studio-border border-transparent bg-card"
                  : "border-border bg-card/40 hover:border-foreground/30",
              )}>
              <div className="flex items-start gap-3">
                <Icon3D icon={t.icon3d} px={44} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-semibold leading-tight">{t.name}</h3>
                    {t.studio ? (
                      <Badge className="shrink-0 gap-1 text-[10px]"><Sparkles className="h-3 w-3" /> {STUDIO_LABELS[t.studio]}</Badge>
                    ) : (
                      <Badge variant="outline" className="shrink-0 text-[10px]">{t.category}</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t.tagline}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground"><Wrench className="h-3 w-3" /> {t.tools.length} tools</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground"><ShieldCheck className="h-3 w-3" /> {t.autonomy}</span>
                <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-primary opacity-0 transition-opacity group-hover:opacity-100">Configure <ChevronRight className="h-3.5 w-3.5" /></span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ── Generate an agent from a plain-language request ──────────────────────────
// No template matches "un agent qui rejoue mes scénarios clients chaque lundi"
// — so describe it and get one. The generated spec is handed to the SAME config
// stepper as a template, so nothing is created until you've reviewed it.
function GenerateFromRequest({ onGenerated }: { onGenerated: (t: AgentTemplate) => void }) {
  const { projectId } = useCurrentContext();
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    const prompt = request.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { spec } = await callEdge<{ spec: GeneratedSpec }>("internal-agent-run", {
        mode: "design", request: prompt, project_id: projectId,
      });
      onGenerated(specToTemplate(spec));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 pb-3">
      <div className="studio-border rounded-2xl bg-card p-3">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <Wand2 className="h-3.5 w-3.5 text-primary" />
          Décrivez l'agent dont vous avez besoin
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Input
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); generate(); } }}
            placeholder="ex. un agent qui corrige les bugs signalés dans mon dépôt et ouvre la PR"
            className="rounded-full"
            disabled={busy}
          />
          <Button onClick={generate} disabled={busy || !request.trim()} className="shrink-0 rounded-full">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            <span className="ml-1.5">{busy ? "Conception…" : "Générer"}</span>
          </Button>
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}

/** What the `design` mode returns — same vocabulary as a template. */
interface GeneratedSpec {
  name: string;
  tagline: string;
  category: AgentCategory;
  studio: AgentTemplate["studio"] | null;
  persona: string;
  soul: string;
  instructions: string;
  autonomy: AutonomyLevel;
  max_steps: number;
  tools: TemplateTool[];
  outcomes: string[];
  suggestedSchedule: AgentTemplate["suggestedSchedule"] | null;
}

function specToTemplate(spec: GeneratedSpec): AgentTemplate {
  return {
    key: `generated-${Date.now()}`,
    name: spec.name,
    tagline: spec.tagline,
    category: spec.category,
    emoji: "✨",
    // Generated agents have no curated icon; the sparkle reads as "made here".
    icon3d: "magic",
    accent: "#7c3aed",
    persona: spec.persona,
    soul: spec.soul ?? "",
    instructions: spec.instructions,
    autonomy: spec.autonomy,
    max_steps: spec.max_steps,
    tools: spec.tools ?? [],
    outcomes: spec.outcomes ?? [],
    ...(spec.studio ? { studio: spec.studio } : {}),
    ...(spec.suggestedSchedule ? { suggestedSchedule: spec.suggestedSchedule } : {}),
  };
}

// ── Config stepper ───────────────────────────────────────────────────────────
const STEPS = ["Identity", "Behaviour", "Tools & autonomy", "Integrations", "Review"];

// Composio toolkits worth suggesting per agent category (verified slugs). Shown
// as connect-first cards in the Integrations step so a user can extend the agent
// with a relevant app beyond the ones the template already declares.
const COMPOSIO_META: Record<string, { label: string; description: string }> = {
  shopify: { label: "Shopify", description: "Boutique : produits, commandes, clients, stock." },
  wix: { label: "Wix", description: "Boutique et commandes Wix." },
  klaviyo: { label: "Klaviyo", description: "Email & SMS marketing, segments, flows." },
  mailchimp: { label: "Mailchimp", description: "Campagnes email et audiences." },
  google_analytics: { label: "Google Analytics", description: "Trafic, sources, conversions du site." },
  googlesheets: { label: "Google Sheets", description: "Lire/écrire des feuilles de calcul." },
  stripe: { label: "Stripe", description: "Paiements, abonnements, remboursements." },
  slack: { label: "Slack", description: "Messages et notifications d'équipe." },
  notion: { label: "Notion", description: "Pages, bases, documentation." },
  gmail: { label: "Gmail", description: "Lire et rédiger des emails." },
  googledrive: { label: "Google Drive", description: "Fichiers et documents partagés." },
  hubspot: { label: "HubSpot", description: "CRM : contacts, deals, pipelines." },
};
const SUGGESTED_COMPOSIO_BY_CATEGORY: Partial<Record<AgentCategory, string[]>> = {
  Revenue: ["klaviyo", "mailchimp", "stripe", "google_analytics", "googlesheets"],
  Marketing: ["mailchimp", "google_analytics", "notion", "googledrive"],
  Growth: ["google_analytics", "mailchimp", "notion"],
  Support: ["slack", "notion"],
  Data: ["googlesheets", "google_analytics"],
  Assistant: ["gmail", "googledrive", "slack", "notion"],
  Personnel: ["gmail", "googlesheets", "googledrive", "notion"],
  Product: ["notion", "googlesheets", "slack"],
};
const DEFAULT_SUGGESTED_COMPOSIO = ["slack", "notion", "googlesheets", "gmail"];

function ConfigStepper({
  template, onBack, onClose, onActivate,
}: {
  template: AgentTemplate;
  onBack: () => void;
  onClose: () => void;
  onActivate: (t: AgentTemplate, o: TemplateOverrides) => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.tagline);
  const [avatar, setAvatar] = useState<string>(templateAvatar(template));
  const [accent, setAccent] = useState(template.accent);
  const [instructions, setInstructions] = useState(template.instructions);
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(template.autonomy);
  const [enabledTools, setEnabledTools] = useState<boolean[]>(template.tools.map(() => true));
  const [activating, setActivating] = useState(false);

  // External integrations (connector_action tools) chosen for this agent.
  // Seed from any connector_action tools already declared by the template.
  const [integrations, setIntegrations] = useState<string[]>(() => {
    const seeded = new Set<string>();
    for (const t of template.tools) {
      if (t.kind === "connector_action") {
        const slug = (t.config?.provider as string | undefined) ?? "";
        if (slug) seeded.add(slug);
      }
    }
    return [...seeded];
  });
  const toggleIntegration = (slug: string) =>
    setIntegrations((a) => (a.includes(slug) ? a.filter((s) => s !== slug) : [...a, slug]));

  // Composio-toolkit tools the template declares (Shopify, Wix, Gmail…). They're
  // managed in the Integrations step too — shown as connect-first cards that
  // link to the Connectors tab, then activated here.
  const composioTemplateTools = useMemo(
    () => template.tools.filter((t) => t.kind === "composio_toolkit" && String(t.config?.toolkit ?? "")),
    [template],
  );
  const [composioToolkits, setComposioToolkits] = useState<string[]>(() =>
    composioTemplateTools.map((t) => String(t.config?.toolkit ?? "")).filter(Boolean),
  );
  const toggleComposio = (slug: string) =>
    setComposioToolkits((a) => (a.includes(slug) ? a.filter((s) => s !== slug) : [...a, slug]));

  const toggleTool = (i: number) => setEnabledTools((a) => a.map((v, idx) => (idx === i ? !v : v)));

  // The template's own tools minus its connector_action AND composio_toolkit
  // rows (both are managed by the Integrations step so we don't double-add them).
  const baseSelectedTools: TemplateTool[] = template.tools.filter(
    (t, i) => enabledTools[i] && t.kind !== "connector_action" && t.kind !== "composio_toolkit",
  );
  // One connector_action tool per chosen integration.
  const integrationTools: TemplateTool[] = integrations.map((slug) => {
    const p = connectorActionProvider(slug);
    return {
      kind: "connector_action" as const,
      name: p ? `Use ${p.name}` : `Use ${slug}`,
      description: p?.description,
      config: { provider: slug },
      requires_approval: false,
    };
  });
  // One composio_toolkit tool per chosen toolkit, preserving the template's
  // name/description for that toolkit.
  const composioToolkitTools: TemplateTool[] = composioToolkits.map((slug) => {
    const t = composioTemplateTools.find((x) => String(x.config?.toolkit ?? "") === slug);
    return {
      kind: "composio_toolkit" as const,
      name: t?.name ?? `Use ${slug}`,
      description: t?.description,
      config: { toolkit: slug },
      requires_approval: false,
    };
  });
  const selectedTools: TemplateTool[] = [...baseSelectedTools, ...integrationTools, ...composioToolkitTools];

  async function activate() {
    setActivating(true);
    try {
      await onActivate(template, { name, description, avatar, accent, instructions, autonomy, tools: selectedTools });
    } finally {
      setActivating(false);
    }
  }

  return (
    <>
      <header className="flex items-center gap-3 p-4">
        <button onClick={onBack} className="rounded-full p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <AgentAvatar url={avatar} className="h-9 w-9 shrink-0 rounded-xl" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Configure: {template.name}</div>
            <div className="text-[11px] text-muted-foreground">Step {step + 1} of {STEPS.length} · {STEPS[step]}</div>
          </div>
        </div>
        <button onClick={onClose} className="rounded-full p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"><X className="h-5 w-5" /></button>
      </header>

      {/* Stepper — clickable for visited steps; a filled rail shows progress. */}
      <div className="flex items-center px-5 pb-4 pt-1">
        {STEPS.map((s, i) => {
          const done = i < step, current = i === step;
          return (
            <div key={s} className="flex flex-1 items-center last:flex-none">
              <button
                type="button"
                onClick={() => i <= step && setStep(i)}
                disabled={i > step}
                className={cn("group flex shrink-0 items-center gap-2", i <= step && "cursor-pointer")}
              >
                <span className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold transition-colors",
                  done ? "bg-primary text-primary-foreground"
                    : current ? "border-2 border-primary bg-primary/10 text-primary"
                    : "border border-border text-muted-foreground",
                )}>
                  {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span className={cn("hidden text-xs font-medium sm:block", current ? "text-foreground" : done ? "text-foreground/70" : "text-muted-foreground")}>{s}</span>
              </button>
              {i < STEPS.length - 1 && (
                <div className="mx-2 h-0.5 flex-1 rounded-full bg-border">
                  <div className={cn("h-full rounded-full bg-primary transition-all duration-300", done ? "w-full" : "w-0")} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {step === 0 && (
          <div className="space-y-4">
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} className="rounded-xl" /></Field>
            <Field label="Short description"><Input value={description} onChange={(e) => setDescription(e.target.value)} className="rounded-xl" /></Field>
            <Field label="Avatar">
              <AvatarPicker value={avatar} onChange={setAvatar} />
            </Field>
            <Field label="Accent">
              <AccentPicker value={accent} onChange={setAccent} />
            </Field>
          </div>
        )}

        {step === 1 && (
          <Field label="Instructions — how the agent should behave">
            <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={14}
              className="w-full rounded-xl border border-border bg-background p-3.5 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring/20" />
            <p className="mt-1 text-[11px] text-muted-foreground">Pre-filled from the template — tweak it to fit your company.</p>
          </Field>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <Field label="Tools — what the agent can use">
              <div className="space-y-2">
                {template.tools.map((t, i) =>
                  (t.kind === "connector_action" || t.kind === "composio_toolkit") ? null : (
                    <label key={i} className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border p-3">
                      <input type="checkbox" checked={enabledTools[i]} onChange={() => toggleTool(i)} className="mt-0.5 h-4 w-4 accent-primary" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-sm">
                          <span className="font-medium">{t.name}</span>
                          <span className="rounded bg-secondary px-1.5 text-[10px] text-muted-foreground">{t.kind}</span>
                          {t.requires_approval && <Badge variant="warning" className="text-[10px]">approval</Badge>}
                        </div>
                        {t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}
                      </div>
                    </label>
                  ),
                )}
                {template.tools.filter((t) => t.kind !== "connector_action" && t.kind !== "composio_toolkit").length === 0 && (
                  <p className="text-xs text-muted-foreground">This template uses only built-in abilities. Add external data sources in the next step.</p>
                )}
              </div>
            </Field>
            <Field label="Autonomy">
              <div className="grid gap-2">
                {AUTONOMY.map((a) => (
                  <button key={a.key} onClick={() => setAutonomy(a.key)}
                    className={cn("rounded-xl border p-3 text-left", autonomy === a.key ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30")}>
                    <div className="text-sm font-medium">{a.label}</div>
                    <div className="text-[11px] text-muted-foreground">{a.desc}</div>
                  </button>
                ))}
              </div>
            </Field>
          </div>
        )}

        {step === 3 && (
          <IntegrationsStep
            selected={integrations}
            onToggle={toggleIntegration}
            declaredComposio={composioTemplateTools.map((t) => String(t.config?.toolkit ?? ""))}
            suggestedComposio={(SUGGESTED_COMPOSIO_BY_CATEGORY[template.category] ?? DEFAULT_SUGGESTED_COMPOSIO)
              .filter((s) => !composioTemplateTools.some((t) => String(t.config?.toolkit ?? "") === s))}
            selectedComposio={composioToolkits}
            onToggleComposio={toggleComposio}
          />
        )}

        {step === 4 && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-2xl border border-border bg-card/40 p-4">
              <AgentAvatar url={avatar} className="h-11 w-11 shrink-0 rounded-xl" />
              <div className="min-w-0">
                <div className="font-semibold">{name}</div>
                <div className="text-xs text-muted-foreground">{description}</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl border border-border p-3"><div className="text-[11px] uppercase text-muted-foreground">Autonomy</div><div className="mt-0.5 font-medium capitalize">{autonomy}</div></div>
              <div className="rounded-xl border border-border p-3"><div className="text-[11px] uppercase text-muted-foreground">Tools</div><div className="mt-0.5 font-medium">{baseSelectedTools.length} enabled</div></div>
            </div>
            {integrations.length > 0 && (
              <div className="rounded-xl border border-border p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase text-muted-foreground"><Plug className="h-3 w-3" /> Integrations</div>
                <div className="flex flex-wrap gap-1.5">
                  {integrations.map((slug) => {
                    const p = connectorActionProvider(slug);
                    return (
                      <span key={slug} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs">
                        {p?.icon && <p.icon className="h-3 w-3" />} {p?.name ?? slug}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
            {template.suggestedSchedule && (
              <div className="flex items-start gap-2 rounded-xl border border-border p-3 text-xs text-muted-foreground">
                <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Suggested schedule: <strong className="text-foreground">{template.suggestedSchedule.label}</strong> — you can enable it later in the agent's missions.</span>
              </div>
            )}
            <ul className="space-y-1">
              {template.outcomes.map((o) => (
                <li key={o} className="flex items-start gap-1.5 text-xs text-foreground/80"><Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" /> {o}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Footer nav */}
      <footer className="flex items-center justify-between gap-2 p-4">
        <Button variant="ghost" onClick={step === 0 ? onBack : () => setStep((s) => s - 1)}>
          <ArrowLeft className="h-4 w-4" /> {step === 0 ? "Templates" : "Back"}
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={() => setStep((s) => s + 1)} disabled={step === 0 && !name.trim()}>
            Next <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button onClick={activate} disabled={activating || !name.trim()}>
            {activating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add agent
          </Button>
        )}
      </footer>
    </>
  );
}

// ── Integrations step ─────────────────────────────────────────────────────────
// Pick external data sources (CRM / HR / data lakes). Each becomes a
// connector_action tool. We surface whether the connector is already configured
// for this project so the user knows it will work at runtime.
function IntegrationsStep({
  selected, onToggle, declaredComposio, suggestedComposio, selectedComposio, onToggleComposio,
}: {
  selected: string[];
  onToggle: (slug: string) => void;
  declaredComposio: string[];
  suggestedComposio: string[];
  selectedComposio: string[];
  onToggleComposio: (slug: string) => void;
}) {
  const { projectId } = useCurrentContext();
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const { data: connectors } = useProjectConnectors(projectId ?? null);
  const connectedSet = useMemo(
    () => new Set((connectors ?? []).filter((c) => c.status === "connected").map((c) => c.provider)),
    [connectors],
  );
  // Catalogue → real logos/counts/chips for the shared ToolkitCard (same card as
  // the Admin Connecteurs tab). Fetched only when there are Composio toolkits.
  const { data: catalog } = useQuery({
    queryKey: ["composio_toolkits_catalog"],
    enabled: declaredComposio.length > 0 || suggestedComposio.length > 0,
    queryFn: async () => {
      const res = await callEdge<{ toolkits: ComposioToolkit[] }>("composio-catalog", {});
      return res.toolkits;
    },
  });
  const catalogBySlug = useMemo(() => new Map((catalog ?? []).map((t) => [t.slug, t])), [catalog]);
  const toolkitFor = (slug: string) => catalogBySlug.get(slug) ?? synthToolkit(slug, COMPOSIO_META[slug]?.label ?? slug, COMPOSIO_META[slug]?.description ?? null);
  // Open the Connectors tab straight on this toolkit's connect dialog.
  const connectToolkit = (slug: string) =>
    navigate(`/app/${workspaceSlug}/${projectSlug}/agent/connectors?connect=${slug}`);

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2 rounded-xl border border-border bg-card/40 p-3 text-xs text-muted-foreground">
        <Plug className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>
          Connect external data sources the agent can pull from — CRM, HR, data lakes. Secrets are stored encrypted at the
          project level and never reach the model. The agent only chooses an action and parameters.
        </span>
      </div>

      {/* Composio toolkits — connect-first cards (same idea as the Connectors
          tab). Connect on the Connectors tab, then activate it here. */}
      {(declaredComposio.length > 0 || suggestedComposio.length > 0) && (
        <div className="space-y-3">
          {declaredComposio.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">Applications de l'agent</div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {declaredComposio.map((slug) => (
                  <ToolkitCard
                    key={slug}
                    toolkit={toolkitFor(slug)}
                    status={connectedSet.has(slug) ? "connected" : undefined}
                    active={selectedComposio.includes(slug)}
                    onToggle={() => onToggleComposio(slug)}
                    onConnect={() => (connectedSet.has(slug) ? onToggleComposio(slug) : connectToolkit(slug))}
                  />
                ))}
              </div>
            </div>
          )}
          {suggestedComposio.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">Autres outils pertinents</div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {suggestedComposio.map((slug) => (
                  <ToolkitCard
                    key={slug}
                    toolkit={toolkitFor(slug)}
                    status={connectedSet.has(slug) ? "connected" : undefined}
                    active={selectedComposio.includes(slug)}
                    onToggle={() => onToggleComposio(slug)}
                    onConnect={() => (connectedSet.has(slug) ? onToggleComposio(slug) : connectToolkit(slug))}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="text-xs font-medium text-muted-foreground">Sources de données internes</div>

      {CONNECTOR_ACTION_GROUPS.map((group) => (
        <div key={group.label} className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">{group.label}</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {group.slugs.map((slug) => {
              const p = connectorActionProvider(slug);
              if (!p) return null;
              const isOn = selected.includes(slug);
              const isConnected = connectedSet.has(slug);
              const Icon = p.icon;
              return (
                <button
                  key={slug}
                  type="button"
                  onClick={() => onToggle(slug)}
                  className={cn(
                    "flex items-start gap-2.5 rounded-xl border p-3 text-left transition-colors",
                    isOn ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30",
                  )}
                >
                  <div className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", isOn ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground")}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{p.name}</span>
                      {isOn && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                    </div>
                    <p className="line-clamp-2 text-[11px] text-muted-foreground">{p.description}</p>
                    <div className="mt-1">
                      {isConnected ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                          <ShieldCheck className="h-3 w-3" /> Connected
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="h-3 w-3" /> Not connected yet
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {selected.some((s) => !connectedSet.has(s)) && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <span>
            Some selected integrations aren't connected for this project yet. The agent will be created with the tool, but
            you'll need to add the credentials in{" "}
            <span className="inline-flex items-center gap-0.5 font-medium text-foreground">Integrations <ExternalLink className="h-3 w-3" /></span>{" "}
            before it can fetch data.
          </span>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

// Accent selector: preset swatches + a free color picker (native <input
// type=color>) shown as a rainbow chip; any custom colour highlights it.
function AccentPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const isPreset = ACCENTS.some((c) => c.toLowerCase() === value.toLowerCase());
  return (
    <div className="flex flex-wrap items-center gap-2">
      {ACCENTS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          title={c}
          className={cn(
            "h-7 w-7 rounded-full ring-2 ring-offset-2 ring-offset-background transition",
            value.toLowerCase() === c.toLowerCase() ? "ring-foreground" : "ring-transparent hover:ring-border",
          )}
          style={{ backgroundColor: c }}
        />
      ))}
      <label
        title="Couleur personnalisée"
        className={cn(
          "relative flex h-7 w-7 cursor-pointer items-center justify-center overflow-hidden rounded-full ring-2 ring-offset-2 ring-offset-background transition",
          !isPreset ? "ring-foreground" : "ring-transparent hover:ring-border",
        )}
        style={{
          background: !isPreset
            ? value
            : "conic-gradient(from 0deg, #ef4444, #f59e0b, #eab308, #22c55e, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #ef4444)",
        }}
      >
        {isPreset && <Palette className="pointer-events-none h-3.5 w-3.5 text-white drop-shadow" />}
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      <span className="ml-1 font-mono text-[11px] text-muted-foreground">{value}</span>
    </div>
  );
}
