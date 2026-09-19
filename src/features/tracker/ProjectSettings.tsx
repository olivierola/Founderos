import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DotsThreeIcon, PlusIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { StateIcon } from "./pickers";
import {
  STATE_GROUPS, WEBHOOK_EVENTS, createLabel, createState, createWebhook,
  deleteLabel, deleteState, deleteWebhook, fetchDeliveries, fetchLabels,
  fetchStates, fetchWebhooks, updateLabel, updateProject, updateState, updateWebhook,
  type PjProject, type PjWebhook, type StateGroup,
} from "./model";
import { useAuth } from "@/lib/auth-context";
import { EstimatesSection } from "./settings/EstimatesSection";
import { MembersSection } from "./settings/MembersSection";
import { ApiTokensSection } from "./settings/ApiTokensSection";
import { TransitionsSection } from "./settings/TransitionsSection";
import { Checkbox, Select, TextField } from "./ui";

/**
 * Les réglages du projet : ses états, ses labels, et les onglets qu'il expose.
 *
 * C'est ici que se joue la personnalisation du flux de travail — un projet de
 * support et un projet produit n'ont pas les mêmes colonnes, et les leur imposer
 * est le premier reproche fait aux outils de suivi.
 */

const LABEL_COLORS = [
  "#2a78d6", "#008300", "#e87ba4", "#eda100",
  "#1baf7a", "#eb6834", "#4a3aa7", "#e34948",
];

export function ProjectSettings({ project, onChanged }: { project: PjProject; onChanged: () => void }) {
  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      <div className="mx-auto max-w-3xl space-y-6">
        <FeaturesSection project={project} onChanged={onChanged} />
        <StatesSection project={project} />
        <LabelsSection project={project} />
        <MembersSection project={project} onChanged={onChanged} />
        <EstimatesSection project={project} />
        <TransitionsSection project={project} onChanged={onChanged} />
        <MaintenanceSection project={project} onChanged={onChanged} />
        <WebhooksSection project={project} />
        <ApiTokensSection workspaceId={project.workspace_id} />
      </div>
    </div>
  );
}

/**
 * L'entretien automatique. Les deux règles sont désactivées par défaut (0) :
 * un outil qui déplace des items sans qu'on le lui ait demandé passe pour un
 * bug, jamais pour un service rendu.
 */
function MaintenanceSection({ project, onChanged }: { project: PjProject; onChanged: () => void }) {
  const rules: { key: "archive_in" | "close_in"; label: string; hint: string }[] = [
    {
      key: "archive_in", label: "Archiver les work items terminés",
      hint: "Retire de la vue ce qui est terminé depuis longtemps, sans le supprimer.",
    },
    {
      key: "close_in", label: "Clore les work items dormants",
      hint: "Bascule en « annulé » ce qui traîne dans le backlog sans avancer.",
    },
  ];

  return (
    <section className="space-y-2">
      <h3 className="text-14 font-medium">Entretien automatique</h3>
      <div className="rounded-lg border border-border/70">
        {rules.map((r) => (
          <div key={r.key} className="flex items-center gap-3 border-b border-border/40 px-3 py-2.5 last:border-0">
            <span className="flex-1">
              <span className="block text-14">{r.label}</span>
              <span className="block text-11 text-muted-foreground">{r.hint}</span>
            </span>
            <Select
              size="xs"
              className="w-36 shrink-0"
              // La valeur est un NOMBRE en base et une chaîne dans le
              // sélecteur : on convertit aux deux bouts plutôt que de stocker
              // du texte, sous peine de comparer « 3 » à 3 quelque part plus
              // tard.
              value={String(project[r.key] ?? 0)}
              onChange={async (v) => {
                await updateProject(project.id, { [r.key]: Number(v) } as Partial<PjProject>);
                onChanged();
              }}
              options={[
                { key: "0", label: "Jamais" },
                ...[1, 3, 6, 9, 12].map((m) => ({ key: String(m), label: `Après ${m} mois` })),
              ]}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Les webhooks. L'envoi passe par une file : un endpoint lent ou mort ne peut
 * pas faire échouer la création du work item qui l'a déclenché — d'où la
 * colonne « état » qui montre ce qui est parti et ce qui a renoncé.
 */
function WebhooksSection({ project }: { project: PjProject }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const dashboardId = project.dashboard_id;

  const { data: hooks } = useQuery({
    queryKey: ["pj_webhooks", dashboardId],
    enabled: !!dashboardId,
    queryFn: () => fetchWebhooks(dashboardId!),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_webhooks", dashboardId] });

  const submit = async () => {
    if (!url.trim() || !dashboardId) return;
    // On valide ici plutôt que de laisser la base accepter n'importe quoi : une
    // URL invalide ne se découvrirait qu'à la première livraison échouée.
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol !== "https:") {
        setError("L'URL doit être en HTTPS : la charge utile contient vos données de projet.");
        return;
      }
    } catch {
      setError("URL invalide.");
      return;
    }
    setError(null);
    await createWebhook({
      workspaceId: project.workspace_id, dashboardId,
      url: url.trim(), events: [...WEBHOOK_EVENTS], createdBy: user?.id ?? null,
    });
    setUrl("");
    refresh();
  };

  if (!dashboardId) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-14 font-medium">Webhooks</h3>
      <p className="text-11 text-muted-foreground">
        Chaque envoi porte un en-tête <code className="font-mono">X-Plane-Signature</code> (HMAC-SHA256
        de la charge utile avec le secret du webhook) pour que le destinataire puisse vérifier l&apos;origine.
      </p>
      <div className="rounded-lg border border-border/70">
        {(hooks ?? []).map((h) => (
          <WebhookRow key={h.id} hook={h} onChanged={refresh} />
        ))}

        <div className="flex items-center gap-2 px-3 py-2">
          <TextField
            value={url} onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="https://exemple.com/hooks/plane" className="h-8 flex-1 text-14"
          />
          <Button size="sm" onClick={submit} disabled={!url.trim()}>Ajouter</Button>
        </div>
        {error && <p className="px-3 pb-2 text-11 text-red-600">{error}</p>}
      </div>
    </section>
  );
}

function WebhookRow({ hook, onChanged }: { hook: PjWebhook; onChanged: () => void }) {
  const [showDeliveries, setShowDeliveries] = useState(false);

  const { data: deliveries } = useQuery({
    queryKey: ["pj_deliveries", hook.id],
    enabled: showDeliveries,
    queryFn: () => fetchDeliveries(hook.id),
  });

  return (
    <div className="border-b border-border/40 px-3 py-2 last:border-0">
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", hook.is_active ? "bg-emerald-500" : "bg-muted-foreground")} />
        <span className="min-w-0 flex-1 truncate font-mono text-12">{hook.url}</span>
        <button
          type="button"
          onClick={() => setShowDeliveries((v) => !v)}
          className="text-11 text-muted-foreground hover:text-foreground"
        >
          Livraisons
        </button>
        <button
          type="button"
          onClick={() => updateWebhook(hook.id, { is_active: !hook.is_active }).then(onChanged)}
          className="text-11 text-muted-foreground hover:text-foreground"
        >
          {hook.is_active ? "Suspendre" : "Réactiver"}
        </button>
        <button
          type="button"
          onClick={async () => { await deleteWebhook(hook.id); onChanged(); }}
          className="text-11 text-muted-foreground hover:text-red-600"
        >
          Supprimer
        </button>
      </div>

      {showDeliveries && (
        <ul className="space-y-1 pt-2">
          {(deliveries ?? []).map((d) => (
            <li key={d.id} className="flex items-center gap-2 text-11">
              <span className={cn(
                "rounded px-1.5 py-0.5",
                d.status === "sent" && "bg-emerald-500/15 text-emerald-600",
                d.status === "failed" && "bg-red-500/15 text-red-600",
                d.status === "pending" && "bg-amber-500/15 text-amber-600",
              )}>
                {d.status === "sent" ? "envoyé" : d.status === "failed" ? "échec" : "en attente"}
              </span>
              <span className="font-mono">{d.event}</span>
              <span className="flex-1 truncate text-muted-foreground">{d.last_error ?? ""}</span>
              <span className="text-muted-foreground">{d.attempts} essai(s)</span>
            </li>
          ))}
          {!deliveries?.length && (
            <li className="text-11 text-placeholder">
              Aucune livraison. Les envois apparaîtront ici avec leur code de
              réponse, ce qui est le seul moyen de savoir si le webhook marche.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Les onglets activables. Un projet qui n'utilise pas les cycles ne doit pas
 *  porter un onglet Cycles vide : c'est du bruit sur chaque écran. */
function FeaturesSection({ project, onChanged }: { project: PjProject; onChanged: () => void }) {
  const features: { key: keyof PjProject; label: string; hint: string }[] = [
    { key: "cycle_view", label: "Cycles", hint: "Itérations bornées dans le temps" },
    { key: "module_view", label: "Modules", hint: "Chantiers bornés par un périmètre" },
    { key: "issue_views_view", label: "Vues", hint: "Jeux de filtres sauvegardés" },
    { key: "page_view", label: "Pages", hint: "Specs, comptes rendus, décisions" },
    { key: "intake_view", label: "Intake", hint: "File d'entrée des demandes à trier" },
  ];

  return (
    <section className="space-y-2">
      <h3 className="text-14 font-medium">Fonctionnalités</h3>
      <div className="rounded-lg border border-border/70">
        {features.map((f) => (
          <Checkbox
            key={f.key}
            className="rounded-none border-b border-border/40 px-3 py-2.5 last:border-0"
            checked={Boolean(project[f.key])}
            onChange={async (v) => {
              await updateProject(project.id, { [f.key]: v } as Partial<PjProject>);
              onChanged();
            }}
            label={<span className="text-14">{f.label}</span>}
            hint={f.hint}
          />
        ))}
      </div>
    </section>
  );
}

function StatesSection({ project }: { project: PjProject }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<StateGroup | null>(null);
  const [name, setName] = useState("");

  const { data: states } = useQuery({
    queryKey: ["pj_states", project.id],
    queryFn: () => fetchStates(project.id),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_states", project.id] });

  const submit = async (group: StateGroup) => {
    if (!name.trim()) return;
    await createState({
      pjProjectId: project.id, workspaceId: project.workspace_id,
      name: name.trim(), color: STATE_GROUPS.find((g) => g.key === group)?.color ?? "#6b7280",
      group,
    });
    setName("");
    setAdding(null);
    refresh();
  };

  return (
    <section className="space-y-2">
      <h3 className="text-14 font-medium">États</h3>
      <div className="space-y-3">
        {STATE_GROUPS.map((g) => {
          const inGroup = (states ?? []).filter((s) => s.group === g.key);
          return (
            <div key={g.key} className="rounded-lg border border-border/70">
              <header className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
                <StateIcon group={g.key} color={g.color} />
                <span className="flex-1 text-12 font-medium">{g.label}</span>
                <button
                  type="button"
                  onClick={() => { setAdding(g.key); setName(""); }}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <PlusIcon className="h-4 w-4" />
                </button>
              </header>

              {inGroup.map((s) => (
                <div key={s.id} className="flex items-center gap-2 border-b border-border/30 px-3 py-2 last:border-0">
                  <StateIcon group={s.group} color={s.color} />
                  <span className="flex-1 text-14">{s.name}</span>
                  {s.is_default && (
                    <span className="inline-flex h-5 items-center rounded bg-muted px-2 text-11 font-medium leading-none text-muted-foreground">
                      Par défaut
                    </span>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted">
                        <DotsThreeIcon className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {!s.is_default && (
                        <DropdownMenuItem
                          onClick={async () => {
                            // Un seul état par défaut : on retire l'ancien
                            // avant de poser le nouveau, sinon l'index partiel
                            // rejette l'écriture.
                            const current = (states ?? []).find((x) => x.is_default);
                            if (current) await updateState(current.id, { is_default: false });
                            await updateState(s.id, { is_default: true });
                            refresh();
                          }}
                        >
                          Définir par défaut
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        className="text-red-600"
                        disabled={s.is_default}
                        onClick={async () => { await deleteState(s.id); refresh(); }}
                      >
                        Supprimer
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}

              {adding === g.key && (
                <div className="flex gap-2 px-3 py-2">
                  <TextField
                    autoFocus value={name} onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submit(g.key);
                      if (e.key === "Escape") setAdding(null);
                    }}
                    placeholder="Nom de l'état" className="h-8 text-14"
                  />
                  <Button size="sm" onClick={() => submit(g.key)}>Ajouter</Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LabelsSection({ project }: { project: PjProject }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState(LABEL_COLORS[0]);

  const { data: labels } = useQuery({
    queryKey: ["pj_labels", project.id],
    queryFn: () => fetchLabels(project.id),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_labels", project.id] });

  const submit = async () => {
    if (!name.trim()) return;
    await createLabel({
      pjProjectId: project.id, workspaceId: project.workspace_id,
      name: name.trim(), color,
    });
    setName("");
    refresh();
  };

  return (
    <section className="space-y-2">
      <h3 className="text-14 font-medium">Labels</h3>
      <div className="rounded-lg border border-border/70">
        {(labels ?? []).map((l) => (
          <div key={l.id} className="flex items-center gap-2 border-b border-border/40 px-3 py-2 last:border-0">
            <span className="h-3 w-3 rounded-full" style={{ background: l.color }} />
            <input
              defaultValue={l.name}
              onBlur={(e) => {
                if (e.target.value.trim() && e.target.value !== l.name) {
                  updateLabel(l.id, { name: e.target.value.trim() }).then(refresh);
                }
              }}
              className="flex-1 bg-transparent text-14 outline-none"
            />
            <div className="flex gap-1">
              {LABEL_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={c}
                  onClick={() => updateLabel(l.id, { color: c }).then(refresh)}
                  className={cn(
                    "h-3.5 w-3.5 rounded-full ring-offset-1 transition-all",
                    l.color === c && "ring-2 ring-foreground/40",
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={async () => { await deleteLabel(l.id); refresh(); }}
              className="text-12 text-muted-foreground hover:text-red-600"
            >
              Supprimer
            </button>
          </div>
        ))}

        <div className="flex items-center gap-2 px-3 py-2">
          <div className="flex gap-1">
            {LABEL_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={cn(
                  "h-3.5 w-3.5 rounded-full transition-all",
                  color === c && "ring-2 ring-foreground/40 ring-offset-1",
                )}
                style={{ background: c }}
              />
            ))}
          </div>
          <TextField
            value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="Nouveau label" className="h-8 flex-1 text-14"
          />
          <Button size="sm" onClick={submit} disabled={!name.trim()}>Ajouter</Button>
        </div>
      </div>
    </section>
  );
}
