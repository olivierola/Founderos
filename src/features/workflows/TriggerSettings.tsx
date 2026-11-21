import { useEffect, useMemo, useState } from "react";
import type { Node } from "reactflow";
import {
  HandTapIcon as Hand,
  CalendarDotsIcon as Calendar,
  WebhooksLogoIcon as Webhook,
  CopyIcon as Copy,
  CheckIcon as Check,
  EyeIcon as Eye,
  EyeSlashIcon as EyeOff,
  ArrowsCounterClockwiseIcon as Regenerate,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { functionUrl } from "@/lib/edge";
import { patchBlock } from "./outline";
import { EventTriggers } from "./EventTriggers";
import {
  nextCronRun, buildCron, parseCron, describeCron, parseNaturalCron,
  DEFAULT_CRON_SPEC, CRON_FREQUENCIES, CRON_WEEKDAYS, type CronSpec,
} from "./model";
import type { Ctx } from "./editor-ctx";

// Ce qui met un workflow en route — le même réglage dans le document et dans
// le panneau du canevas. Il vivait dans le document seul : sur le canevas, le
// bloc déclencheur s'ouvrait sur un panneau vide, et l'on ne pouvait ni le
// planifier ni le passer en webhook sans changer de vue.
//
// Trois modes, portés par le bloc : manuel, programmé, webhook. Les ÉVÉNEMENTS
// d'outils (un mail arrive, un message est posté) sont autre chose — de vrais
// abonnements chez le fournisseur — et s'ajoutent en dessous.

export type TriggerMode = "manual" | "schedule" | "webhook";

export const TRIGGER_MODES: Array<{ id: TriggerMode; label: string; hint: string; icon: typeof Hand }> = [
  { id: "manual", label: "Manuel", hint: "Lancé à la main, depuis cet écran ou par un agent", icon: Hand },
  { id: "schedule", label: "Programmé", hint: "À heure fixe, selon un rythme", icon: Calendar },
  { id: "webhook", label: "Webhook", hint: "Un appel HTTP entrant lance le run", icon: Webhook },
];

/** Le nom du mode, pour une carte ou une liste. Un ancien mode « événement »
 *  reste lisible : il est montré pour ce qu'il est, pas déguisé en manuel. */
export function triggerModeLabel(mode: unknown): string {
  const m = String(mode ?? "manual");
  if (m === "event") return "Événement (ancien)";
  return TRIGGER_MODES.find((x) => x.id === m)?.label ?? "Manuel";
}

/** 32 octets aléatoires en hexadécimal : assez pour qu'un jeton ne se devine
 *  pas, et sans caractère à échapper dans une URL. */
function newWebhookToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function webhookUrlOf(workflowId: string, token?: string): string {
  const base = functionUrl(`automation-receiver?workflow=${encodeURIComponent(workflowId)}`);
  return token ? `${base}&token=${token}` : base;
}

export function TriggerSettings({ trigger, ctx, compact }: {
  trigger: Node;
  ctx: Ctx;
  /** Dans le panneau du canevas : les modes en liste plutôt qu'en pastilles. */
  compact?: boolean;
}) {
  const d = (trigger.data ?? {}) as Record<string, unknown>;
  const mode = String(d.mode ?? "manual");
  const patch = (p: Record<string, unknown>) => ctx.apply((g) => patchBlock(g, trigger.id, p));

  const choose = (m: TriggerMode) => patch({
    mode: m,
    // Sans expression, « programmé » ne déclenche rien du tout.
    ...(m === "schedule" && !String(d.schedule ?? "").trim() ? { schedule: DEFAULT_CRON_SPEC.expression } : {}),
    // Le jeton naît avec le mode : une URL de webhook sans jeton serait
    // refusée au premier appel.
    ...(m === "webhook" && !String(d.webhook_token ?? "").trim() ? { webhook_token: newWebhookToken() } : {}),
  });

  return (
    <div>
      <div className={cn(compact ? "grid gap-1.5" : "grid gap-2 sm:grid-cols-3")} role="radiogroup" aria-label="Mode de déclenchement">
        {TRIGGER_MODES.map((m) => {
          const on = mode === m.id;
          return (
            <button
              key={m.id} type="button" role="radio" aria-checked={on}
              onClick={() => choose(m.id)}
              className={cn(
                "flex items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors",
                on
                  ? "border-emerald-500/50 bg-emerald-500/10"
                  : "border-border hover:border-foreground/25 hover:bg-muted/50",
              )}
            >
              <span className={cn(
                "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                on ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground",
              )}>
                <m.icon className="h-3.5 w-3.5" weight="bold" />
              </span>
              <span className="min-w-0">
                <span className={cn("block text-[12.5px] font-medium leading-tight", on && "text-emerald-700 dark:text-emerald-300")}>
                  {m.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{m.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      {mode === "schedule" && (
        <CronPicker value={String(d.schedule ?? "")} onChange={(expr) => patch({ schedule: expr })} />
      )}

      {mode === "webhook" && (
        <WebhookPanel
          workflowId={ctx.workflowId}
          token={String(d.webhook_token ?? "")}
          onRegenerate={() => patch({ webhook_token: newWebhookToken() })}
        />
      )}

      {/* Le mode « événement » du bloc n'a jamais rien souscrit : il n'écrit
          qu'une ligne de frontmatter. Le dire, plutôt que de laisser un
          workflow attendre un déclenchement qui ne viendra pas. */}
      {mode === "event" && (
        <p className="mt-2 rounded-lg bg-amber-500/5 p-2 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
          Ce workflow est réglé sur un événement nommé « {String(d.event ?? "")} », qui n'est que documentaire.
          Choisissez un mode ci-dessus et ajoutez l'événement réel juste en dessous.
        </p>
      )}

      {ctx.workspaceId && ctx.projectId && (
        <div className="mt-3">
          <EventTriggers workflowId={ctx.workflowId} workspaceId={ctx.workspaceId} projectId={ctx.projectId} />
        </div>
      )}
    </div>
  );
}

// ── Webhook ─────────────────────────────────────────────────────────────────

function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return [copied, (key, text) => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(key)).catch(() => {});
  }];
}

/**
 * L'adresse à donner au service qui déclenchera le workflow.
 *
 * Le jeton est dans l'URL, parce que beaucoup d'outils (formulaires, CRM,
 * no-code) ne savent que coller une adresse. Il est masqué à l'écran : une
 * capture partagée ne doit pas suffire à lancer le workflow. Le régénérer
 * révoque l'ancien d'un coup.
 */
function WebhookPanel({ workflowId, token, onRegenerate }: {
  workflowId: string; token: string; onRegenerate: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, copy] = useCopy();

  const full = token ? webhookUrlOf(workflowId, token) : "";
  const masked = token ? webhookUrlOf(workflowId, `${token.slice(0, 4)}${"•".repeat(12)}`) : "";
  const curl = `curl -X POST '${webhookUrlOf(workflowId)}' \\\n  -H 'X-Webhook-Token: ${shown ? token : "<jeton>"}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"email": "client@exemple.fr"}'`;

  if (!token) {
    return (
      <div className="mt-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-[12px]">
        <p className="text-amber-700 dark:text-amber-300">Aucun jeton : les appels seront refusés.</p>
        <button type="button" onClick={onRegenerate} className="mt-2 rounded-lg border border-border bg-background px-2.5 py-1 text-[12px] hover:bg-muted">
          Générer un jeton
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2.5 space-y-2.5 rounded-xl border border-border bg-muted/20 p-3">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-medium text-muted-foreground">URL du webhook · POST</span>
          <div className="flex items-center gap-0.5">
            <IconButton title={shown ? "Masquer le jeton" : "Afficher le jeton"} onClick={() => setShown((v) => !v)}>
              {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </IconButton>
            <IconButton title="Copier l'URL" onClick={() => copy("url", full)}>
              {copied === "url" ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            </IconButton>
          </div>
        </div>
        <code className="block break-all rounded-lg border border-border/70 bg-background px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">
          {shown ? full : masked}
        </code>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Le corps JSON de l'appel arrive dans le run : <code className="rounded bg-muted px-1 font-mono">{"{{trigger.email}}"}</code>.
        Le jeton peut aussi passer dans l'en-tête <code className="rounded bg-muted px-1 font-mono">X-Webhook-Token</code> plutôt que dans l'URL.
        Le workflow doit être <span className="font-medium text-foreground">actif</span> pour accepter les appels.
      </p>

      <details className="group">
        <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground hover:text-foreground">
          Exemple d'appel
        </summary>
        <div className="relative mt-1.5">
          <pre className="overflow-x-auto rounded-lg border border-border/70 bg-background p-2.5 pr-8 font-mono text-[10.5px] leading-relaxed">{curl}</pre>
          <div className="absolute right-1 top-1">
            <IconButton title="Copier la commande" onClick={() => copy("curl", curl.replace("<jeton>", token))}>
              {copied === "curl" ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            </IconButton>
          </div>
        </div>
      </details>

      <div className="flex items-center gap-2">
        {confirming ? (
          <>
            <span className="text-[11px] text-amber-600 dark:text-amber-400">L'ancienne URL cessera de fonctionner.</span>
            <button type="button" onClick={() => { onRegenerate(); setConfirming(false); }}
              className="rounded-lg bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-500/25 dark:text-amber-300">
              Régénérer
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded-lg px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted">
              Annuler
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
            <Regenerate className="h-3 w-3" /> Régénérer le jeton
          </button>
        )}
      </div>
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
      {children}
    </button>
  );
}

// ── Programmé ───────────────────────────────────────────────────────────────

/**
 * Dire quand, en français.
 *
 * Les pastilles couvrent le courant ; elles ne savent pas dire « du lundi au
 * vendredi à 18 h » ni « toutes les 15 minutes », et il ne restait alors que
 * l'expression brute — c'est-à-dire rien, pour qui ne connaît pas la syntaxe.
 *
 * L'application se fait à ⏎ ou à la sortie du champ, jamais à la frappe : en
 * cours de saisie, « tous les jours » se lit avant « tous les jours ouvrés » et
 * enregistrerait une planification qu'on n'a pas fini d'écrire. La ligne de
 * dessous montre ce que ça donnera, avant.
 */
function NaturalCron({ onChange }: { onChange: (expr: string) => void }) {
  const [text, setText] = useState("");
  const parsed = useMemo(() => (text.trim() ? parseNaturalCron(text) : null), [text]);

  const commit = () => {
    if (!parsed) return;
    onChange(parsed);
    setText("");
  };

  return (
    <div>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        onBlur={commit}
        placeholder="Dites quand : « tous les lundis à 9h », « en semaine à 18h », « toutes les 15 minutes »…"
        className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
      />
      {text.trim() && (
        <p className={cn("mt-1 text-[11px]", parsed ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
          {parsed
            ? <>→ {describeCron(parsed)} · ⏎ pour appliquer</>
            : "Pas compris, reformulez, ou réglez avec les boutons ci-dessous."}
        </p>
      )}
    </div>
  );
}

/**
 * Planifier sans écrire de cron.
 *
 * On choisit une fréquence, une heure, un jour. Ce qui est ENREGISTRÉ reste une
 * expression cron — le format que le planificateur lit déjà, et que quelqu'un
 * qui la connaît peut toujours saisir via « Expression cron ».
 *
 * Deux choses sont montrées en permanence, parce que ce sont les deux erreurs
 * qu'on fait : l'heure est en UTC, et la prochaine échéance réelle — la seule
 * preuve que l'expression fait ce qu'on croit.
 */
export function CronPicker({ value, onChange }: { value: string; onChange: (expr: string) => void }) {
  const spec = useMemo(() => parseCron(value || DEFAULT_CRON_SPEC.expression), [value]);
  const set = (patch: Partial<CronSpec>) => {
    const next = { ...spec, ...patch };
    onChange(next.frequency === "custom" ? next.expression : buildCron(next));
  };

  const next = useMemo(() => nextCronRun(value), [value]);
  const valid = !!next;

  return (
    <div className="mt-2.5 space-y-2.5 rounded-xl border border-border bg-muted/20 p-3">
      <NaturalCron onChange={onChange} />
      <div className="flex flex-wrap items-center gap-1.5">
        {CRON_FREQUENCIES.map((f) => (
          <button
            key={f.id} type="button"
            onClick={() => set(f.id === "custom" ? { frequency: "custom", expression: value || buildCron(spec) } : { frequency: f.id })}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[12px] transition-colors",
              spec.frequency === f.id
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
          >{f.label}</button>
        ))}
      </div>

      {spec.frequency === "custom" ? (
        <input
          value={spec.expression}
          onChange={(e) => set({ expression: e.target.value })}
          placeholder="0 9 * * 1"
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-primary/50"
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {spec.frequency === "weekly" && (
            <div className="flex flex-wrap items-center gap-1">
              {CRON_WEEKDAYS.map((w) => (
                <button
                  key={w.id} type="button" title={w.label}
                  onClick={() => set({ weekday: w.id })}
                  className={cn(
                    "h-7 w-9 rounded-lg text-[12px] capitalize transition-colors",
                    spec.weekday === w.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70",
                  )}
                >{w.short}</button>
              ))}
            </div>
          )}
          {spec.frequency === "monthly" && (
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              le
              <input
                type="number" min={1} max={28}
                value={spec.day}
                onChange={(e) => set({ day: Number(e.target.value) })}
                className="w-14 rounded-lg border border-border bg-background px-2 py-1 text-center text-[13px] tabular-nums outline-none focus:border-primary/50"
              />
            </label>
          )}
          <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            {spec.frequency === "hourly" ? "à la minute" : "à"}
            <input
              type="time"
              value={`${String(spec.hour).padStart(2, "0")}:${String(spec.minute).padStart(2, "0")}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                set({ hour: Number.isFinite(h) ? h : spec.hour, minute: Number.isFinite(m) ? m : spec.minute });
              }}
              className="rounded-lg border border-border bg-background px-2 py-1 text-[13px] tabular-nums outline-none focus:border-primary/50"
            />
            <span className="text-muted-foreground/70">UTC</span>
          </label>
        </div>
      )}

      <p className={cn("text-[11px] leading-relaxed", valid ? "text-muted-foreground" : "text-amber-500")}>
        {valid ? (
          <>
            {describeCron(value)} · prochain lancement{" "}
            <span className="font-medium text-foreground">
              {next!.toLocaleString("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}
            </span>{" "}
            <span className="text-muted-foreground/70">(votre heure)</span>
          </>
        ) : (
          "Cette expression n'est pas valide, rien ne se déclenchera."
        )}
      </p>
    </div>
  );
}
