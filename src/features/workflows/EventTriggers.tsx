import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleNotchIcon as Loader2,
  PlusIcon as Plus,
  TrashIcon as Trash2,
  ArrowsClockwiseIcon as RefreshCw,
  LightningIcon as Zap,
  WarningIcon as AlertTriangle,
  CheckIcon as Check,
  ClockIcon as Clock,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Field, Picker, TextField, TextArea } from "./inspector-ui";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  fetchEventTriggers, addEventTrigger, removeEventTrigger, retryEventTrigger,
  fetchEventDeliveries, type EventTrigger,
} from "./model";

// Subscriptions to what happens in a connected tool. Shown in the trigger
// block's inspector, because "when a mail arrives" IS the trigger — it just
// happens to need a subscription upstream, a filter, and a delivery log to be
// debuggable.

/** Events worth offering by name. Composio exposes far more per toolkit; these
 *  are the ones a workflow is actually built on, and anything else can be typed
 *  in by slug. */
const KNOWN_EVENTS: Record<string, { slug: string; label: string }[]> = {
  gmail: [
    { slug: "GMAIL_NEW_GMAIL_MESSAGE", label: "Nouveau mail reçu" },
    { slug: "GMAIL_NEW_LABELED_EMAIL", label: "Mail étiqueté" },
  ],
  slack: [
    { slug: "SLACK_NEW_MESSAGE", label: "Nouveau message" },
    { slug: "SLACK_REACTION_ADDED", label: "Réaction ajoutée" },
  ],
  github: [
    { slug: "GITHUB_ISSUE_ADDED_EVENT", label: "Issue créée" },
    { slug: "GITHUB_PULL_REQUEST_EVENT", label: "Pull request" },
  ],
  notion: [{ slug: "NOTION_PAGE_ADDED_TO_DATABASE", label: "Page ajoutée" }],
  linear: [{ slug: "LINEAR_ISSUE_CREATED", label: "Issue créée" }],
  hubspot: [{ slug: "HUBSPOT_NEW_CONTACT", label: "Nouveau contact" }],
};

const STATUS_META: Record<string, { label: string; tone: string; icon: typeof Check }> = {
  active: { label: "actif", tone: "text-emerald-500", icon: Check },
  pending: { label: "en attente", tone: "text-muted-foreground", icon: Clock },
  paused: { label: "en pause", tone: "text-amber-500", icon: Clock },
  error: { label: "erreur", tone: "text-red-500", icon: AlertTriangle },
};

export function EventTriggers({ workflowId, workspaceId, projectId }: {
  workflowId: string; workspaceId: string; projectId: string;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const { data: triggers, isLoading } = useQuery({
    queryKey: ["wf_triggers", workflowId],
    queryFn: () => fetchEventTriggers(workflowId),
  });
  const { data: connectors } = useQuery({
    queryKey: ["wf_trigger_connectors", projectId],
    queryFn: async () => {
      const { data } = await supabase.from("connectors")
        .select("provider").eq("project_id", projectId)
        .eq("source", "composio").eq("status", "connected");
      return [...new Set(((data ?? []) as Array<{ provider: string }>).map((c) => c.provider))].sort();
    },
  });
  const { data: deliveries } = useQuery({
    queryKey: ["wf_deliveries", workflowId],
    enabled: (triggers ?? []).length > 0,
    queryFn: () => fetchEventDeliveries(workflowId, 8),
    refetchInterval: 15000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["wf_triggers", workflowId] });
    qc.invalidateQueries({ queryKey: ["wf_deliveries", workflowId] });
  };

  return (
    <div className="space-y-2">
      {(triggers ?? []).length > 0 && (
        <div className="space-y-1.5">
          {(triggers ?? []).map((t) => (
            <TriggerRow key={t.id} trigger={t} onChanged={invalidate} />
          ))}
        </div>
      )}

      {isLoading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      ) : adding ? (
        <AddTrigger
          connectors={connectors ?? []}
          onCancel={() => setAdding(false)}
          onAdd={async (provider, eventSlug, filter) => {
            await addEventTrigger({ workflowId, workspaceId, projectId, provider, eventSlug, filter });
            setAdding(false);
            invalidate();
          }}
        />
      ) : (
        <button
          type="button" onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <Zap className="h-3 w-3" /> Sur un événement d'une app
        </button>
      )}

      {/* Le journal répond à la seule question qui compte quand une procédure
          « n'est pas partie » : l'événement est-il arrivé, et qu'en a-t-on fait ? */}
      {(deliveries ?? []).length > 0 && (
        <details className="group/log">
          <summary className="cursor-pointer list-none text-[11px] text-muted-foreground hover:text-foreground">
            Derniers événements reçus ({(deliveries ?? []).length})
          </summary>
          <ul className="mt-1.5 space-y-1 border-l border-border pl-3">
            {(deliveries ?? []).map((d) => (
              <li key={d.id} className="flex items-start gap-1.5 text-[11px]">
                <span className={cn(
                  "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                  d.outcome === "started" ? "bg-emerald-500"
                    : d.outcome === "filtered" ? "bg-muted-foreground/60"
                    : d.outcome === "failed" ? "bg-red-500" : "bg-amber-500",
                )} />
                <span className="min-w-0 flex-1 text-muted-foreground">
                  <span className="font-medium text-foreground">{
                    d.outcome === "started" ? "lancé"
                      : d.outcome === "filtered" ? "filtré"
                      : d.outcome === "skipped" ? "ignoré" : "échec"
                  }</span>
                  {d.detail ? ` — ${d.detail}` : ""}
                  <span className="ml-1 opacity-60">
                    {new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })
                      .format(new Date(d.received_at))}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function TriggerRow({ trigger, onChanged }: { trigger: EventTrigger; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const meta = STATUS_META[trigger.status] ?? STATUS_META.pending;
  const known = (KNOWN_EVENTS[trigger.provider] ?? []).find((e) => e.slug === trigger.event_slug);

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-2.5">
      <div className="flex items-start gap-2">
        <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">
            {trigger.provider} · {known?.label ?? trigger.event_slug}
          </span>
          <span className={cn("mt-0.5 flex items-center gap-1 text-[11px]", meta.tone)}>
            <meta.icon className="h-3 w-3" /> {meta.label}
            {trigger.last_event_at && (
              <span className="text-muted-foreground">
                · dernier {new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(new Date(trigger.last_event_at))}
              </span>
            )}
          </span>
        </span>
        {trigger.status === "error" && (
          <button
            type="button" title="Réessayer l'abonnement" disabled={busy}
            onClick={async () => { setBusy(true); try { await retryEventTrigger(trigger.id); onChanged(); } finally { setBusy(false); } }}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          >{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}</button>
        )}
        <button
          type="button" title="Supprimer" disabled={busy}
          onClick={async () => { setBusy(true); try { await removeEventTrigger(trigger.id); onChanged(); } finally { setBusy(false); } }}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
        ><Trash2 className="h-3.5 w-3.5" /></button>
      </div>

      {trigger.status_detail && (
        <p className="mt-1.5 text-[11px] leading-snug text-red-500">{trigger.status_detail}</p>
      )}
      {trigger.filter && (
        <p className="mt-1.5 pl-5 text-[11px] leading-snug text-muted-foreground">
          <span className="font-medium text-foreground">Seulement si</span> {trigger.filter}
        </p>
      )}
    </div>
  );
}

/**
 * Souscrire à un événement, en trois décisions : quelle app, quel événement,
 * et sous quelle condition.
 *
 * Les champs passent par les primitives du module (Field / Picker / TextField /
 * TextArea) et non par des `<select>` bruts. Ce n'est pas cosmétique : un select
 * natif hérite du thème du système, pas du nôtre — il apparaît blanc sur une
 * interface sombre, et sa flèche ne ressemble à aucun autre contrôle de l'écran.
 */
function AddTrigger({ connectors, onAdd, onCancel }: {
  connectors: string[];
  onAdd: (provider: string, eventSlug: string, filter: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState(connectors[0] ?? "");
  const [slug, setSlug] = useState("");
  const [custom, setCustom] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const known = KNOWN_EVENTS[provider] ?? [];
  // Une app sans catalogue connu se saisit au slug : mieux vaut un champ libre
  // qu'une liste vide qui laisse croire que rien n'est écoutable.
  const freeform = known.length === 0 || slug === "__custom";
  const eventSlug = freeform ? custom.trim() : slug;

  if (connectors.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-3 text-[12px] leading-relaxed text-muted-foreground">
        Aucune app connectée dans ce projet.{" "}
        <button type="button" onClick={onCancel} className="font-medium text-foreground underline">Fermer</button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Application">
          <Picker
            value={provider}
            onChange={(v) => { setProvider(v); setSlug(""); setCustom(""); }}
            options={connectors.map((c) => ({ value: c, label: c }))}
          />
        </Field>
        <Field label="Événement">
          {known.length > 0 ? (
            <Picker
              value={slug}
              onChange={setSlug}
              placeholder="Choisir…"
              options={[
                ...known.map((e) => ({ value: e.slug, label: e.label, hint: e.slug })),
                { value: "__custom", label: "Autre…", hint: "Saisir le slug exact" },
              ]}
            />
          ) : (
            <TextField mono value={custom} onChange={setCustom} placeholder="SLUG_DE_L_EVENEMENT" />
          )}
        </Field>
      </div>

      {known.length > 0 && slug === "__custom" && (
        <Field label="Slug de l'événement">
          <TextField mono value={custom} onChange={setCustom} placeholder="GMAIL_NEW_GMAIL_MESSAGE" />
        </Field>
      )}

      <Field
        label="Seulement si"
        hint="Évalué AVANT tout démarrage — la procédure ne se lance pas pour découvrir que l'événement ne la concernait pas."
      >
        <TextArea
          value={filter} onChange={setFilter} minRows={2}
          placeholder="l'expéditeur est un client, et le message mentionne une facture"
        />
      </Field>

      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
        <Button
          size="sm"
          disabled={busy || !provider || !eventSlug}
          onClick={async () => {
            setBusy(true);
            try { await onAdd(provider, eventSlug, filter); } finally { setBusy(false); }
          }}
        >
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Écouter
        </Button>
      </div>
    </div>
  );
}
