import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Sparkles, X, Check, Wrench, ShieldCheck, CalendarClock, ArrowLeft, ArrowRight,
  Loader2, Plus, ChevronRight, Plug, AlertTriangle, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useProjectConnectors } from "@/hooks/useConnectors";
import {
  AGENT_TEMPLATES, type AgentTemplate, type AgentCategory, type AutonomyLevel, type TemplateTool,
} from "./agentTemplates";
import type { TemplateOverrides } from "./instantiateTemplate";
import { CONNECTOR_ACTION_GROUPS, connectorActionProvider } from "./connectorActionProviders";

const EMOJIS = ["🤖", "🧠", "🛠️", "🎯", "📊", "✍️", "🔍", "📦", "💼", "⚡", "🛡️", "💸", "🎧"];
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
      {/* Right drawer — full viewport height, wide. */}
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-[70] flex h-screen w-full max-w-3xl flex-col border-l border-border bg-background shadow-2xl transition-transform duration-300 lg:max-w-4xl",
          open ? "translate-x-0" : "translate-x-full",
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
  const cats = useMemo(() => {
    const order: AgentCategory[] = [];
    for (const t of AGENT_TEMPLATES) if (!order.includes(t.category)) order.push(t.category);
    return order;
  }, []);
  const visible = useMemo(() => (cat === "All" ? AGENT_TEMPLATES : AGENT_TEMPLATES.filter((t) => t.category === cat)), [cat]);

  return (
    <>
      <header className="flex items-start justify-between gap-3 border-b border-border p-4">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="text-base font-semibold">Agent templates</h2>
            <span className="text-xs text-muted-foreground">· {AGENT_TEMPLATES.length} ready-to-run</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Pick a template, configure it, then add it to your team.</p>
        </div>
        <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
          <X className="h-5 w-5" />
        </button>
      </header>

      <div className="flex flex-wrap gap-1.5 border-b border-border p-3">
        {(["All", ...cats] as const).map((c) => (
          <button key={c} onClick={() => setCat(c)}
            className={cn("rounded-full border px-2.5 py-1 text-xs transition-colors",
              cat === c ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
            {c}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {visible.map((t) => (
            <button key={t.key} onClick={() => onSelect(t)}
              className="group flex flex-col rounded-xl border border-border bg-card/40 p-4 text-left transition-colors hover:border-foreground/30">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-lg"
                  style={{ backgroundColor: t.accent + "22", color: t.accent }}>{t.emoji}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-semibold leading-tight">{t.name}</h3>
                    <Badge variant="outline" className="shrink-0 text-[10px]">{t.category}</Badge>
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

// ── Config stepper ───────────────────────────────────────────────────────────
const STEPS = ["Identity", "Behaviour", "Tools & autonomy", "Integrations", "Review"];

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
  const [emoji, setEmoji] = useState(template.emoji);
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

  const toggleTool = (i: number) => setEnabledTools((a) => a.map((v, idx) => (idx === i ? !v : v)));

  // The template's own tools minus its connector_action rows (those are managed
  // by the Integrations step so we don't double-add them).
  const baseSelectedTools: TemplateTool[] = template.tools.filter(
    (t, i) => enabledTools[i] && t.kind !== "connector_action",
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
  const selectedTools: TemplateTool[] = [...baseSelectedTools, ...integrationTools];

  async function activate() {
    setActivating(true);
    try {
      await onActivate(template, { name, description, emoji, accent, instructions, autonomy, tools: selectedTools });
    } finally {
      setActivating(false);
    }
  }

  return (
    <>
      <header className="flex items-center gap-3 border-b border-border p-4">
        <button onClick={onBack} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-base" style={{ backgroundColor: accent + "22", color: accent }}>{emoji}</div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Configure: {template.name}</div>
            <div className="text-[11px] text-muted-foreground">Step {step + 1} of {STEPS.length} · {STEPS[step]}</div>
          </div>
        </div>
        <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"><X className="h-5 w-5" /></button>
      </header>

      {/* Stepper rail */}
      <div className="flex items-center gap-1 border-b border-border px-4 py-2.5">
        {STEPS.map((s, i) => (
          <div key={s} className="flex flex-1 items-center gap-1.5">
            <div className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium",
              i < step ? "bg-primary text-primary-foreground" : i === step ? "border border-primary text-primary" : "border border-border text-muted-foreground")}>
              {i < step ? <Check className="h-3 w-3" /> : i + 1}
            </div>
            <span className={cn("hidden truncate text-[11px] sm:block", i === step ? "text-foreground" : "text-muted-foreground")}>{s}</span>
            {i < STEPS.length - 1 && <div className="h-px flex-1 bg-border" />}
          </div>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {step === 0 && (
          <div className="space-y-4">
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Short description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            <Field label="Avatar">
              <div className="flex flex-wrap gap-1.5">
                {EMOJIS.map((e) => (
                  <button key={e} onClick={() => setEmoji(e)} className={cn("flex h-9 w-9 items-center justify-center rounded-md border text-lg", emoji === e ? "border-primary bg-primary/10" : "border-border")}>{e}</button>
                ))}
              </div>
            </Field>
            <Field label="Accent">
              <div className="flex flex-wrap gap-2">
                {ACCENTS.map((c) => (
                  <button key={c} onClick={() => setAccent(c)} className={cn("h-7 w-7 rounded-full border-2", accent === c ? "border-foreground" : "border-transparent")} style={{ backgroundColor: c }} />
                ))}
              </div>
            </Field>
          </div>
        )}

        {step === 1 && (
          <Field label="Instructions — how the agent should behave">
            <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={14}
              className="w-full rounded-md border border-border bg-background p-3 text-sm leading-relaxed" />
            <p className="mt-1 text-[11px] text-muted-foreground">Pre-filled from the template — tweak it to fit your company.</p>
          </Field>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <Field label="Tools — what the agent can use">
              <div className="space-y-2">
                {template.tools.map((t, i) =>
                  t.kind === "connector_action" ? null : (
                    <label key={i} className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-2.5">
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
                {template.tools.filter((t) => t.kind !== "connector_action").length === 0 && (
                  <p className="text-xs text-muted-foreground">This template uses only built-in abilities. Add external data sources in the next step.</p>
                )}
              </div>
            </Field>
            <Field label="Autonomy">
              <div className="grid gap-2">
                {AUTONOMY.map((a) => (
                  <button key={a.key} onClick={() => setAutonomy(a.key)}
                    className={cn("rounded-md border p-3 text-left", autonomy === a.key ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30")}>
                    <div className="text-sm font-medium">{a.label}</div>
                    <div className="text-[11px] text-muted-foreground">{a.desc}</div>
                  </button>
                ))}
              </div>
            </Field>
          </div>
        )}

        {step === 3 && (
          <IntegrationsStep selected={integrations} onToggle={toggleIntegration} />
        )}

        {step === 4 && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card/40 p-4">
              <div className="flex h-11 w-11 items-center justify-center rounded-md text-xl" style={{ backgroundColor: accent + "22", color: accent }}>{emoji}</div>
              <div className="min-w-0">
                <div className="font-semibold">{name}</div>
                <div className="text-xs text-muted-foreground">{description}</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-md border border-border p-3"><div className="text-[11px] uppercase text-muted-foreground">Autonomy</div><div className="mt-0.5 font-medium capitalize">{autonomy}</div></div>
              <div className="rounded-md border border-border p-3"><div className="text-[11px] uppercase text-muted-foreground">Tools</div><div className="mt-0.5 font-medium">{baseSelectedTools.length} enabled</div></div>
            </div>
            {integrations.length > 0 && (
              <div className="rounded-md border border-border p-3">
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
              <div className="flex items-start gap-2 rounded-md border border-border p-3 text-xs text-muted-foreground">
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
      <footer className="flex items-center justify-between gap-2 border-t border-border p-4">
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
  selected, onToggle,
}: {
  selected: string[];
  onToggle: (slug: string) => void;
}) {
  const { projectId } = useCurrentContext();
  const { data: connectors } = useProjectConnectors(projectId ?? null);
  const connectedSet = useMemo(
    () => new Set((connectors ?? []).filter((c) => c.status === "connected").map((c) => c.provider)),
    [connectors],
  );

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2 rounded-md border border-border bg-card/40 p-3 text-xs text-muted-foreground">
        <Plug className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>
          Connect external data sources the agent can pull from — CRM, HR, data lakes. Secrets are stored encrypted at the
          project level and never reach the model. The agent only chooses an action and parameters.
        </span>
      </div>

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
                    "flex items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors",
                    isOn ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30",
                  )}
                >
                  <div className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md", isOn ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground")}>
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
