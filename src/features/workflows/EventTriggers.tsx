import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, RefreshCw, Zap, AlertTriangle, Check, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
      <div className="flex items-center gap-1.5">
        <Zap className="h-3.5 w-3.5 text-amber-500" />
        <span className="text-[11px] font-medium text-muted-foreground">Événements d'outils connectés</span>
      </div>

      {isLoading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      ) : (
        <div className="space-y-1.5">
          {(triggers ?? []).map((t) => (
            <TriggerRow key={t.id} trigger={t} onChanged={invalidate} />
          ))}

          {adding ? (
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
              className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border/70 py-1.5 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
            >
              <Plus className="h-3 w-3" /> Écouter un événement
            </button>
          )}
        </div>
      )}

      {/* The delivery log answers the only question that matters when a
          workflow "didn't fire": did the event arrive, and what happened to it. */}
      {(deliveries ?? []).length > 0 && (
        <div className="rounded-md border border-border/60 bg-muted/20 p-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Derniers événements reçus
          </p>
          <ul className="space-y-0.5">
            {(deliveries ?? []).map((d) => (
              <li key={d.id} className="flex items-start gap-1.5 text-[10px]">
                <span className={cn(
                  "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                  d.outcome === "started" ? "bg-emerald-500"
                    : d.outcome === "filtered" ? "bg-muted-foreground/60"
                    : d.outcome === "failed" ? "bg-red-500" : "bg-amber-500",
                )} />
                <span className="min-w-0 flex-1 text-muted-foreground">
                  <span className="font-medium">{
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
        </div>
      )}
    </div>
  );
}

function TriggerRow({ trigger, onChanged }: { trigger: EventTrigger; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const meta = STATUS_META[trigger.status] ?? STATUS_META.pending;
  const known = (KNOWN_EVENTS[trigger.provider] ?? []).find((e) => e.slug === trigger.event_slug);

  return (
    <div className="rounded-md border border-border/60 bg-background p-2">
      <div className="flex items-start gap-1.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {trigger.provider} · {known?.label ?? trigger.event_slug}
          </span>
          <span className={cn("mt-0.5 flex items-center gap-1 text-[10px]", meta.tone)}>
            <meta.icon className="h-2.5 w-2.5" /> {meta.label}
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
          >{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}</button>
        )}
        <button
          type="button" title="Supprimer" disabled={busy}
          onClick={async () => { setBusy(true); try { await removeEventTrigger(trigger.id); onChanged(); } finally { setBusy(false); } }}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
        ><Trash2 className="h-3 w-3" /></button>
      </div>

      {trigger.status_detail && (
        <p className="mt-1 text-[10px] leading-snug text-red-500">{trigger.status_detail}</p>
      )}
      {trigger.filter && (
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
          <span className="font-medium">Seulement si :</span> {trigger.filter}
        </p>
      )}
    </div>
  );
}

function AddTrigger({ connectors, onAdd, onCancel }: {
  connectors: string[];
  onAdd: (provider: string, eventSlug: string, filter: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState(connectors[0] ?? "");
  const [slug, setSlug] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const known = KNOWN_EVENTS[provider] ?? [];

  if (connectors.length === 0) {
    return (
      <div className="rounded-md border border-border/60 bg-muted/20 p-2 text-[10px] text-muted-foreground">
        Aucune app connectée via Composio dans ce projet. Connectez-en une dans
        Ressources → Connexions pour écouter ses événements.
        <button type="button" onClick={onCancel} className="ml-1 underline">Fermer</button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 rounded-md border border-primary/40 bg-background p-2">
      <select
        value={provider}
        onChange={(e) => { setProvider(e.target.value); setSlug(""); }}
        className="h-7 w-full rounded border border-input bg-background px-1.5 text-[11px] outline-none focus:border-primary/60"
      >
        {connectors.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>

      {known.length > 0 ? (
        <select
          value={slug} onChange={(e) => setSlug(e.target.value)}
          className="h-7 w-full rounded border border-input bg-background px-1.5 text-[11px] outline-none focus:border-primary/60"
        >
          <option value="">— choisir un événement —</option>
          {known.map((e) => <option key={e.slug} value={e.slug}>{e.label}</option>)}
          <option value="__custom">Autre (saisir le slug)…</option>
        </select>
      ) : null}

      {(known.length === 0 || slug === "__custom") && (
        <Input
          value={slug === "__custom" ? "" : slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="SLUG_DE_L_EVENEMENT"
          className="h-7 font-mono text-[11px]"
        />
      )}

      <textarea
        value={filter} onChange={(e) => setFilter(e.target.value)} rows={2}
        placeholder="Filtre (optionnel) : l'expéditeur est un client, le message mentionne une facture…"
        className="w-full resize-none rounded border border-input bg-background px-1.5 py-1 text-[11px] outline-none focus:border-primary/60"
      />
      <p className="text-[10px] leading-snug text-muted-foreground">
        Le filtre est évalué avant tout démarrage — inutile de lancer la procédure pour découvrir que
        l'événement ne la concernait pas.
      </p>

      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">Annuler</button>
        <Button
          size="sm" className="h-6 text-[11px]"
          disabled={busy || !provider || !slug || slug === "__custom"}
          onClick={async () => { setBusy(true); try { await onAdd(provider, slug, filter); } finally { setBusy(false); } }}
        >
          {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Écouter
        </Button>
      </div>
    </div>
  );
}
