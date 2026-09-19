import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Node, Edge } from "reactflow";
import {
  XIcon as X,
  PlusIcon as Plus,
  ArrowsOutSimpleIcon as Maximize2,
  PencilLineIcon as PenLine,
  BooksIcon as Library,
  CheckIcon as Check,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import {
  CONNECTOR_ACTION_SLUGS, connectorActionProvider,
} from "@/features/internal-agents/connectorActionProviders";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { BLOCK_BY_KIND, blockColorClass, KNOWN_TOOLS, DELIVERABLE_FORMATS } from "./blocks";
import { paramsOf, agentIdsOf, contextSourceOf, contextBodyOf, type InputParam, type ContextRef } from "./context";
import { roleOf, targetsOfQualifier, attachmentsByTarget } from "./graph";
import { Field, TextField, TextArea, Segmented, Picker, Switch, Stepper, ChipPicker, Section } from "./inspector-ui";
import { EventTriggers } from "./EventTriggers";
import type { BlockKind } from "./model";

// Les réglages d'un bloc — les champs, et rien d'autre.
//
// Ce formulaire était le panneau latéral du canevas ; il est maintenant ouvert
// depuis le document, sous le bloc qu'il configure. Le contenu n'a pas bougé :
// chaque champ correspond à UNE clé de `data`, celle que le compilateur lit.
// Ce que vous voyez ici est littéralement ce qui atterrit dans le playbook.
//
// Il ne porte plus ni en-tête, ni bouton de suppression, ni largeur : la ligne
// du document au-dessus dit déjà de quel bloc il s'agit, et propose déjà de le
// supprimer. Un panneau qui redit le titre qu'on vient de lire et remet un
// second bouton « supprimer » à côté du premier fait douter qu'ils fassent la
// même chose.

export function BlockForm({
  node, nodes, edges, agents, collections, workflowId, workspaceId, projectId,
  onPatch, onAttach, onDetach,
}: {
  node: Node;
  /** Tout le graphe : un formulaire qui ne voit pas le câblage ne peut pas le montrer. */
  nodes: Node[];
  edges: Edge[];
  agents: Array<{ id: string; name: string }>;
  collections: Array<{ id: string; name: string }>;
  workflowId: string;
  workspaceId: string | null;
  projectId: string | null;
  onPatch: (patch: Record<string, unknown>) => void;
  onAttach: (qualifierId: string, actionId: string) => void;
  onDetach: (qualifierId: string, actionId: string) => void;
}) {
  const kind = (node.type || "step") as BlockKind;
  const def = BLOCK_BY_KIND.get(kind)!;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => String(v ?? "");

  // `rich` = the field is a piece of writing, not a one-liner: it gets the
  // markdown surface (tab indents, monospace, room to breathe) instead of a
  // three-line box that makes writing a procedure feel like filling a slot.
  const BODY_HINT: Partial<Record<BlockKind, { label: string; placeholder: string; rows: number; rich?: boolean }>> = {
    goal: {
      label: "Ce qui est visé", rows: 6, rich: true,
      placeholder: "Produire chaque lundi une synthèse des irritants clients de la semaine, exploitable par l'équipe produit.\n\nC'est fait quand : la synthèse existe, chaque irritant est chiffré et cite des verbatims réels.",
    },
    rule: {
      label: "La règle", rows: 4,
      placeholder: "Ne jamais conclure sur un irritant étayé par moins de 3 tickets.",
    },
    resource: {
      label: "Où la trouver / comment l'utiliser", rows: 4,
      placeholder: "Base Zendesk, via le connecteur. Filtrer sur les tickets de la semaine écoulée.",
    },
    step: {
      label: "Consigne détaillée", rows: 10, rich: true,
      placeholder: "Récupère les tickets fermés depuis lundi.\n\nRegroupe-les par thème avant de conclure. Ignore ceux clos en moins de 5 minutes : ce sont des doublons.\n\nVérifie que chaque thème contient au moins 3 tickets avant de le retenir.",
    },
    decision: {
      label: "Ce qu'il faut trancher", rows: 4,
      placeholder: "Y a-t-il au moins un irritant classé critique ?",
    },
    approval: {
      label: "Ce qu'on demande à l'humain", rows: 4,
      placeholder: "Valider l'envoi de la synthèse à l'équipe produit avant publication.",
    },
    deliverable: {
      label: "Ce qui doit être produit", rows: 4,
      placeholder: "Une synthèse en 3 sections : irritants, volumes, recommandations.",
    },
    example: {
      label: "Le cas, traité de bout en bout", rows: 10, rich: true,
      placeholder: "Semaine du 3 mars : 142 tickets, 3 thèmes retenus…",
    },
    input: {
      label: "Précisions sur les entrées", rows: 3,
      placeholder: "Les paramètres viennent du formulaire de lancement, ou du mail déclencheur.",
    },
    tool: {
      label: "Pourquoi cet outil, et comment s'en servir", rows: 4,
      placeholder: "Chercher les tarifs publiés, pas les estimations de mémoire. Deux requêtes maximum par fournisseur.",
    },
    handoff: {
      label: "Le brief remis au destinataire", rows: 8, rich: true,
      placeholder: "Analyse le marché des moteurs 2D open source.\n\nCompare licences, communauté et maturité. Ne conclus pas sur un moteur sans avoir vu son dépôt.",
    },
    memory: {
      label: "Ce qu'il faut retenir", rows: 4,
      placeholder: "Le fournisseur retenu et son prix négocié, pour ne pas relancer la comparaison au prochain run.",
    },
  };
  // Le texte d'une ACTION s'écrit sur sa ligne, dans le document — c'est là
  // qu'on y pose des pastilles, et c'est là qu'elles ont un sens. Le remettre
  // ici donnerait deux champs pour une même valeur, dont l'un afficherait les
  // jetons `{{b:…}}` bruts au lieu des pastilles qu'ils représentent.
  const bodyCfg = roleOf(kind) === "action" ? undefined : BODY_HINT[kind];

  return (
      <div className="space-y-3">
          <Field label="Titre" hint="Devient le titre de la section dans le document.">
            <TextField value={str(d.label)} onChange={(v) => onPatch({ label: v })} placeholder={def.label} />
          </Field>
          {bodyCfg && (
            <Field label={bodyCfg.label}>
              {bodyCfg.rich ? (
                <MarkdownEditor
                  value={str(d.body)} onChange={(v) => onPatch({ body: v })}
                  minHeight={bodyCfg.rows * 22} placeholder={bodyCfg.placeholder}
                  footer={<span>Markdown — repris tel quel dans le document.</span>}
                />
              ) : (
                <TextArea
                  value={str(d.body)} onChange={(v) => onPatch({ body: v })}
                  minRows={bodyCfg.rows} placeholder={bodyCfg.placeholder}
                />
              )}
            </Field>
          )}
          {/* Delegation + scoped knowledge. This is what a workflow is FOR:
              instead of one monolithic instruction file on every run, each
              part carries exactly the context it needs, handed to exactly
              the agent that needs it. */}
          {(kind === "step" || kind === "loop") && (
            <Field
              label="Confier à"
              hint="Laisser vide = l'assistant s'en charge lui-même ou choisit."
            >
              <Picker
                value={str(d.agent_id)}
                onChange={(v) => onPatch({ agent_id: v || null })}
                emptyLabel="L'assistant décide"
                options={agents.map((a) => ({ value: a.id, label: a.name }))}
              />
            </Field>
          )}

          {(kind === "step" || kind === "loop") && (
            <ContextPicker
              refs={Array.isArray(d.refs) ? (d.refs as ContextRef[]) : []}
              collections={collections}
              onChange={(refs) => onPatch({ refs })}
            />
          )}

          {kind === "context" && (
            <>
              <ContextSource
                source={contextSourceOf(d)}
                body={str(d.body)}
                refs={Array.isArray(d.refs) ? (d.refs as ContextRef[]) : []}
                collections={collections}
                onPatch={onPatch}
              />
              <Field label="Portée" hint="Locale : ne vaut que pour la branche où le bloc se trouve.">
                <Segmented value={str(d.scope) || "global"} onChange={(v) => onPatch({ scope: v })} options={[
                  { value: "global", label: "Tout le workflow" },
                  { value: "local", label: "Cette branche" },
                ]} />
              </Field>
            </>
          )}

          {kind === "loop" && (
            <>
              <Field label="Type de boucle">
                <Segmented value={str(d.mode) || "foreach"} onChange={(v) => onPatch({ mode: v })} options={[
                  { value: "foreach", label: "Pour chaque" },
                  { value: "until", label: "Jusqu'à" },
                ]} />
              </Field>
              {d.mode === "until" ? (
                <Field label="Condition de sortie">
                  <TextArea value={str(d.until)} onChange={(v) => onPatch({ until: v })} minRows={2}
                    placeholder="tous les tickets de la file ont été qualifiés" />
                </Field>
              ) : (
                <Field label="Sur quoi itérer" hint="Au-delà d'une dizaine d'éléments, l'assistant parallélisera.">
                  <TextArea value={str(d.over)} onChange={(v) => onPatch({ over: v })} minRows={2}
                    placeholder="chaque compte client signalé à l'étape précédente" />
                </Field>
              )}
              <Field label="Plafond d'itérations" hint="Sans plafond, une boucle mal fermée brûle le budget du run.">
                <Stepper value={Number(d.max) || 20} onChange={(v) => onPatch({ max: v })} min={1} max={200} suffix="itérations" />
              </Field>
            </>
          )}

          {kind === "input" && (
            <ParamList
              params={paramsOf(d)}
              onChange={(params) => onPatch({ params })}
            />
          )}

          {kind === "tool" && (
            <>
              <ToolTarget d={d} projectId={projectId} workspaceId={workspaceId} onPatch={onPatch} />
              <Field label="Exigence">
                <Switch
                  checked={d.required !== false}
                  onChange={(v) => onPatch({ required: v })}
                  label="Passage obligatoire"
                  hint={d.required === false
                    ? "Laissé au jugement de l'agent."
                    : "L'agent doit passer par cet outil, même s'il pense connaître la réponse."}
                />
              </Field>
            </>
          )}

          {kind === "handoff" && (
            <>
              <Field label="Destinataires" hint="Plusieurs = la procédure éclate en travail d'équipe.">
                <ChipPicker
                  selected={agentIdsOf(d)}
                  onChange={(agent_ids) => onPatch({ agent_ids })}
                  options={agents.map((a) => ({ value: a.id, label: a.name }))}
                  emptyHint="Aucun agent dans ce service — créez-en un d'abord."
                />
              </Field>
              {agentIdsOf(d).length > 1 && (
                <Field label="Ordre" hint="Parallèle suppose des tâches vraiment indépendantes.">
                  <Segmented value={str(d.mode) || "sequential"} onChange={(v) => onPatch({ mode: v })} options={[
                    { value: "sequential", label: "L'un après l'autre" },
                    { value: "parallel", label: "En parallèle" },
                  ]} />
                </Field>
              )}
              <Field
                label="Ce qui doit revenir"
                hint="Sans contrat de retour, on récupère trois paragraphes là où on attendait un chiffre."
              >
                <TextArea value={str(d.expects)} onChange={(v) => onPatch({ expects: v })} minRows={3}
                  placeholder="Un tableau comparatif : moteur, licence, dernière release, taille de la communauté." />
              </Field>
              <ContextPicker
                refs={Array.isArray(d.refs) ? (d.refs as ContextRef[]) : []}
                collections={collections}
                onChange={(refs) => onPatch({ refs })}
              />
            </>
          )}

          {kind === "memory" && (
            <Field label="Portée" hint="Ce qui est retenu ici sera relu par les runs suivants.">
              <Segmented value={str(d.scope) || "team"} onChange={(v) => onPatch({ scope: v })} columns={3} options={[
                { value: "team", label: "L'équipe", hint: "Les agents de ce service." },
                { value: "workspace", label: "L'espace", hint: "Tout l'espace de travail." },
                { value: "personal", label: "Cet agent", hint: "Lui seul s'en souviendra." },
              ]} />
            </Field>
          )}

          {kind === "deliverable" && (
            <>
              {/* La même liste que celle du menu `/` — deux copies finiraient
                  par proposer des formats différents selon l'endroit. */}
              <Field label="Format">
                <Picker
                  value={str(d.format) || "report"}
                  onChange={(v) => onPatch({ format: v })}
                  options={DELIVERABLE_FORMATS}
                />
              </Field>
              {str(d.format) === "json" && (
                <Field
                  label="Schéma attendu"
                  hint="Un livrable JSON est lu par un programme : la forme fait partie du livrable."
                >
                  <MarkdownEditor
                    value={str(d.schema)} onChange={(v) => onPatch({ schema: v })}
                    minHeight={160}
                    placeholder={'{\n  "decision": "approve | reject",\n  "confidence": 0.0,\n  "reason": "…"\n}'}
                  />
                </Field>
              )}
            </>
          )}
          <AttachmentSection
            node={node} nodes={nodes} edges={edges}
            onAttach={onAttach} onDetach={onDetach}
          />

      </div>

  );
}

/**
 * The wiring, said in words.
 *
 * A qualifier shows what it is scoped to; an action shows what has been hung on
 * it. Both are editable here, because the ports are 8 px wide and a relation
 * that can only be created by a precise drag is a relation half the users never
 * find. Le document reste le chemin rapide — on pose une pastille dans la
 * phrase et l'attachement est fait ; ceci est le chemin explicite, pour voir
 * d'un coup d'œil tout ce qui pend à un bloc. Les deux écrivent la même arête.
 */
function AttachmentSection({ node, nodes, edges, onAttach, onDetach }: {
  node: Node;
  nodes: Node[];
  edges: Edge[];
  onAttach: (qualifierId: string, actionId: string) => void;
  onDetach: (qualifierId: string, actionId: string) => void;
}) {
  const role = roleOf(node.type);
  // Structural, not React Flow's `Node`: the graph relations come from the
  // shared workflow language, which describes a node without depending on the
  // canvas library. Naming a block needs its kind and its label, nothing else.
  const nameOf = (n: { type?: string; data?: Record<string, unknown> }) => {
    const label = String((n.data as Record<string, unknown> | undefined)?.label ?? "").trim();
    return label || BLOCK_BY_KIND.get((n.type ?? "step") as BlockKind)?.label || "Bloc";
  };

  if (role === "qualifier") {
    const targets = targetsOfQualifier(nodes, edges, node.id);
    const actions = nodes.filter((n) => roleOf(n.type) === "action" && !targets.some((t) => t.id === n.id));
    return (
      <Section
        title="Portée"
        hint={targets.length
          ? "Ce bloc n'écrit plus sa propre section : il est repris dans chaque action ci-dessous, et nulle part ailleurs."
          : "Non attaché : il devient une section du document, valable pour toute la procédure. Attachez-le à une action pour ne le charger que là."}
      >
        <div className="space-y-1.5">
          {targets.map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded-lg border border-violet-400/30 bg-violet-400/5 px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[12px]">{nameOf(t)}</span>
              <button
                type="button" onClick={() => onDetach(node.id, t.id)} title="Détacher"
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
              ><X className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          {actions.length > 0 && (
            <Picker
              value="" onChange={(v) => v && onAttach(node.id, v)}
              placeholder={targets.length ? "Attacher à une autre action…" : "Attacher à une action…"}
              options={actions.map((a) => ({
                value: a.id,
                label: nameOf(a),
                hint: BLOCK_BY_KIND.get((a.type ?? "step") as BlockKind)?.label,
              }))}
            />
          )}
        </div>
      </Section>
    );
  }

  if (role !== "action") return null;
  const attached = (attachmentsByTarget(nodes, edges).get(node.id) ?? []);
  const free = nodes.filter((n) => roleOf(n.type) === "qualifier" && !attached.some((q) => q.id === n.id));
  return (
    <Section
      title="Cadrage attaché"
      hint="Contexte, règles, outils imposés — chargés à CETTE action seulement, et repris dans son bloc du document."
    >
      <div className="space-y-1.5">
        {attached.map((q) => {
          const qd = BLOCK_BY_KIND.get((q.type ?? "context") as BlockKind);
          return (
            <div key={q.id} className="flex items-center gap-2 rounded-lg border border-violet-400/30 bg-violet-400/5 px-2 py-1.5">
              {qd && <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded border", blockColorClass(qd.color))}>
                <qd.icon className="h-3 w-3" />
              </span>}
              <span className="min-w-0 flex-1 truncate text-[12px]">{nameOf(q)}</span>
              <button
                type="button" onClick={() => onDetach(q.id, node.id)} title="Détacher"
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
              ><X className="h-3.5 w-3.5" /></button>
            </div>
          );
        })}
        {attached.length === 0 && (
          <p className="rounded-lg border border-dashed border-border/70 px-2.5 py-2 text-[11px] leading-snug text-muted-foreground">
            Rien d'attaché. Tirez le point violet d'un bloc de cadrage jusqu'au bord gauche de celui-ci — ou choisissez-le ci-dessous.
          </p>
        )}
        {free.length > 0 && (
          <Picker
            value="" onChange={(v) => v && onAttach(v, node.id)}
            placeholder="Attacher un cadrage…"
            options={free.map((q) => ({
              value: q.id,
              label: nameOf(q),
              hint: BLOCK_BY_KIND.get((q.type ?? "context") as BlockKind)?.label,
            }))}
          />
        )}
      </div>
    </Section>
  );
}

/**
 * Ce que ce bloc impose : une CAPACITÉ, ou une ACTION précise sur une app.
 *
 * La distinction est celle entre une procédure et une automatisation. « Cherche
 * sur le web » laisse l'agent décider de la requête ; « hubspot → list_deals »
 * décrit un appel exact, qu'on peut relire dans le document et prévoir. Les deux
 * ont leur place, et rien ne dit laquelle choisir à l'avance — d'où deux onglets
 * plutôt qu'un champ qui essaie de faire les deux.
 *
 * Le catalogue d'actions n'est pas recopié ici : il est demandé au backend, qui
 * le tient déjà (connector-action sans `action` liste le provider). Une copie
 * dans le bundle dériverait au premier ajout d'action.
 */
function ToolTarget({ d, projectId, workspaceId, onPatch }: {
  d: Record<string, unknown>;
  projectId: string | null;
  workspaceId: string | null;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const str = (v: unknown) => String(v ?? "");
  const provider = str(d.provider);
  const isAction = !!provider;

  // Les apps réellement connectées à CE projet, croisées avec celles qui
  // exposent des actions. Proposer une app non connectée produit un bloc qui
  // échouera à l'exécution, sans rien dire au moment où on l'écrit.
  const { data: providers } = useQuery({
    queryKey: ["wf_action_providers", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("connectors")
        .select("provider, status").eq("project_id", projectId!);
      const connected = new Set(
        ((data ?? []) as Array<{ provider: string; status: string }>)
          .filter((c) => ["connected", "read_only", "write_enabled"].includes(c.status))
          .map((c) => c.provider),
      );
      return CONNECTOR_ACTION_SLUGS.filter((s) => connected.has(s));
    },
  });

  const { data: actions, isLoading: loadingActions } = useQuery({
    queryKey: ["wf_actions", projectId, provider],
    enabled: !!projectId && !!workspaceId && !!provider,
    queryFn: async () => {
      // L'endpoint sans `action` est la DÉCOUVERTE : il rend le catalogue du
      // provider, avec la description et les paramètres déclarés de chaque
      // action. C'est ce qui permet d'afficher de vrais champs plutôt qu'un
      // JSON à deviner.
      const res = await callEdge<{
        actions?: Array<{
          name: string; description: string; write?: boolean;
          params?: Record<string, { type?: string; description?: string }>;
        }>;
      }>("connector-action", { workspace_id: workspaceId, project_id: projectId, provider });
      return res?.actions ?? [];
    },
  });

  return (
    <>
      <Field label="Ce que ce bloc impose">
        <Segmented
          value={isAction ? "action" : "capability"}
          onChange={(v) => onPatch(v === "action"
            ? { tool: "", provider: providers?.[0] ?? "", action: "" }
            : { provider: "", action: "", args: {}, tool: "web_search" })}
          options={[
            { value: "capability", label: "Une capacité", hint: "Recherche, code, appel HTTP…" },
            { value: "action", label: "Une action", hint: "Un appel précis sur une app connectée." },
          ]}
          columns={2}
        />
      </Field>

      {!isAction ? (
        <>
          <Field label="Outil" hint="L'agent a déjà sa boîte à outils — ce bloc dit lequel s'impose ici.">
            <Picker
              value={KNOWN_TOOLS.some((t) => t.value === str(d.tool)) ? str(d.tool) : "__custom"}
              onChange={(v) => onPatch({ tool: v === "__custom" ? "" : v })}
              options={[
                ...KNOWN_TOOLS.map((t) => ({ ...t, hint: t.value })),
                { value: "__custom", label: "Autre…", hint: "Saisir le nom exact de l'outil" },
              ]}
            />
          </Field>
          {!KNOWN_TOOLS.some((t) => t.value === str(d.tool)) && (
            <Field label="Nom de l'outil" hint="Tel qu'il apparaît dans l'onglet Accès de l'agent.">
              <TextField mono value={str(d.tool)} onChange={(v) => onPatch({ tool: v })} placeholder="gmail_send_email" />
            </Field>
          )}
        </>
      ) : (
        <>
          <Field label="Application">
            {providers && providers.length > 0 ? (
              <Picker
                value={provider}
                onChange={(v) => onPatch({ provider: v, action: "", args: {} })}
                options={providers.map((s) => ({ value: s, label: connectorActionProvider(s)?.name ?? s, hint: s }))}
              />
            ) : (
              <p className="rounded-lg bg-muted/40 p-2.5 text-[11px] leading-snug text-muted-foreground">
                Aucune application connectée n'expose d'actions. Connectez-en une dans l'onglet Connecteurs du service.
              </p>
            )}
          </Field>

          {provider && (
            <Field label="Action" hint="Exécutée telle quelle par l'agent, sans qu'il ait à la choisir.">
              {loadingActions ? (
                <p className="text-[11px] text-muted-foreground">Lecture du catalogue…</p>
              ) : (
                <Picker
                  value={str(d.action)}
                  onChange={(v) => onPatch({ action: v })}
                  placeholder="Choisir une action…"
                  options={(actions ?? []).map((a) => ({
                    value: a.name,
                    // Le marqueur d'écriture est le seul détail qui change la
                    // nature du choix : lire est réversible, écrire non.
                    label: a.write ? `${a.name} · écrit` : a.name,
                    hint: a.description,
                  }))}
                />
              )}
            </Field>
          )}

          {str(d.action) && (
            <ActionParams
              params={(actions ?? []).find((a) => a.name === str(d.action))?.params ?? {}}
              args={(d.args ?? {}) as Record<string, unknown>}
              onChange={(args) => onPatch({ args })}
            />
          )}
        </>
      )}
    </>
  );
}


/**
 * Les paramètres d'une action, tels que le connecteur les DÉCLARE.
 *
 * Ils étaient saisis en JSON brut. Ça marche pour qui connaît déjà l'API, et
 * pour personne d'autre : rien ne disait quels paramètres existaient, lesquels
 * étaient attendus, ni ce qu'ils signifiaient — il fallait aller lire le
 * catalogue côté serveur. Or le catalogue les décrit déjà et l'endpoint de
 * découverte les renvoie : autant les afficher.
 *
 * Un champ laissé vide n'est PAS envoyé. C'est ce qui distingue « ne pas
 * préciser » (l'agent ou l'API décide) de « envoyer une chaîne vide », deux
 * choses que la plupart des API traitent très différemment.
 */
function ActionParams({ params, args, onChange }: {
  params: Record<string, { type?: string; description?: string }>;
  args: Record<string, unknown>;
  onChange: (args: Record<string, unknown>) => void;
}) {
  const names = Object.keys(params);
  const set = (name: string, raw: string) => {
    const next = { ...args };
    if (!raw.trim()) delete next[name];
    else {
      // Un nombre reste un nombre. Un gabarit `{{…}}` reste une chaîne : c'est
      // le moteur qui le résoudra, et le convertir ici le casserait.
      const isTemplate = raw.includes("{{");
      const n = Number(raw);
      next[name] = !isTemplate && raw.trim() !== "" && Number.isFinite(n) && params[name]?.type === "number"
        ? n
        : raw;
    }
    onChange(next);
  };

  if (names.length === 0) {
    return (
      <Field label="Paramètres">
        <p className="rounded-lg bg-muted/40 p-2.5 text-[11px] leading-snug text-muted-foreground">
          Cette action n'attend aucun paramètre.
        </p>
      </Field>
    );
  }

  return (
    <Field
      label="Paramètres"
      hint="Vide = non transmis. Utilisez {{trigger.champ}} ou {{steps.bloc.champ}} pour reprendre une valeur du run."
    >
      <div className="space-y-2">
        {names.map((name) => {
          const p = params[name] ?? {};
          return (
            <div key={name} className="space-y-1 rounded-lg border border-border/60 bg-background p-2">
              <div className="flex items-baseline gap-1.5">
                <code className="text-[11px] font-medium">{name}</code>
                {p.type && <span className="text-[10px] text-muted-foreground">{p.type}</span>}
              </div>
              {p.description && (
                <p className="text-[10px] leading-snug text-muted-foreground">{p.description}</p>
              )}
              <TextField
                mono
                value={args[name] == null ? "" : String(args[name])}
                onChange={(v) => set(name, v)}
                placeholder={p.type === "number" ? "20" : "{{trigger.from}}"}
              />
            </div>
          );
        })}
      </div>
    </Field>
  );
}

/** The parameters a run needs before it starts. A list rather than a free-text
 *  field because the assistant has to be able to tell WHICH one is missing when
 *  it asks for it. */
function ParamList({ params, onChange }: {
  params: InputParam[];
  onChange: (p: InputParam[]) => void;
}) {
  const patch = (i: number, p: Partial<InputParam>) =>
    onChange(params.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <Field label="Paramètres attendus">
      <div className="space-y-1.5">
        {params.map((p, i) => (
          <div key={i} className="space-y-1 rounded-lg border border-border/60 bg-background p-2">
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <TextField mono
                  value={p.name ?? ""} onChange={(v) => patch(i, { name: v })}
                  placeholder="nom_du_parametre"
                />
              </div>
              <button
                type="button" onClick={() => patch(i, { required: p.required === false })}
                title={p.required === false ? "Rendre obligatoire" : "Rendre facultatif"}
                className={cn(
                  "shrink-0 rounded px-1.5 py-1 text-[10px] font-medium",
                  p.required === false ? "bg-muted text-muted-foreground" : "bg-rose-400/15 text-rose-400",
                )}
              >{p.required === false ? "facultatif" : "requis"}</button>
              <button
                type="button" onClick={() => onChange(params.filter((_, j) => j !== i))}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
              ><X className="h-3 w-3" /></button>
            </div>
            <TextField
              value={p.description ?? ""} onChange={(v) => patch(i, { description: v })}
              placeholder="À quoi il sert, et à quoi ressemble une valeur valide"
            />
          </div>
        ))}
        <button
          type="button" onClick={() => onChange([...params, { name: "", description: "", required: true }])}
          className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border/70 py-1.5 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
        ><Plus className="h-3 w-3" /> Ajouter un paramètre</button>
      </div>
    </Field>
  );
}


/**
 * The context block's editor: ONE source, chosen explicitly.
 *
 * Either you write the knowledge here — and then it is the block, in full, in
 * the same markdown surface as a skill or a procedure — or you point at
 * collections the agent will search. Mixing the two was the previous design and
 * it produced blocks where the written half and the retrieved half disagreed,
 * with nothing in the document saying which one won.
 *
 * Switching sides never deletes anything: the compiler reads the active source
 * only, so the other side sits dormant and comes back intact if you switch
 * again. What is dormant is stated, because invisible content that stops
 * reaching the agent is exactly the kind of thing nobody notices.
 */
function ContextSource({ source, body, refs, collections, onPatch }: {
  source: "write" | "collections";
  body: string;
  refs: ContextRef[];
  collections: Array<{ id: string; name: string }>;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const picked = refs.filter((r) => r.kind === "collection");
  const legacyText = refs.filter((r) => r.kind === "text" && r.body?.trim());
  const written = body.trim() ? body : contextBodyOf({ body, refs });

  const toggle = (c: { id: string; name: string }) => {
    const on = picked.some((r) => r.id === c.id);
    onPatch({
      refs: on
        ? refs.filter((r) => !(r.kind === "collection" && r.id === c.id))
        : [...refs, { kind: "collection", id: c.id, label: c.name } as ContextRef],
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-muted/30 p-0.5">
        {([
          { v: "write", label: "Rédiger", icon: PenLine },
          { v: "collections", label: "Collections", icon: Library },
        ] as const).map((o) => (
          <button
            key={o.v} type="button" onClick={() => onPatch({ source: o.v })}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium transition-colors",
              source === o.v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <o.icon className="h-3 w-3" /> {o.label}
          </button>
        ))}
      </div>

      {source === "write" ? (
        <>
          <MarkdownEditor
            value={written}
            // The first edit folds any legacy free-text ref into `body`, so the
            // block ends up with one place its text lives instead of two.
            onChange={(v) => onPatch(legacyText.length
              ? { body: v, refs: refs.filter((r) => r.kind !== "text") }
              : { body: v })}
            minHeight={280}
            placeholder={"## Ce qu'il faut savoir\n\nLes remises au-delà de 15 % passent par la direction commerciale.\n\n## Vocabulaire\n\n« Compte stratégique » = plus de 50 k€ de CA annuel."}
            footer={<span>Transmis intégralement à l'agent — pas de recherche, pas de troncature.</span>}
          />
          {picked.length > 0 && (
            <DormantSide
              text={`${picked.length} collection${picked.length > 1 ? "s" : ""} rattachée${picked.length > 1 ? "s" : ""} — ignorée${picked.length > 1 ? "s" : ""} tant que le bloc est en mode Rédiger.`}
              onClear={() => onPatch({ refs: refs.filter((r) => r.kind !== "collection") })}
            />
          )}
        </>
      ) : (
        <>
          {collections.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/70 p-3 text-[11px] leading-snug text-muted-foreground">
              Aucune collection dans ce projet. Créez-en une dans <strong>Ressources → Mémoire</strong>,
              ou repassez en <strong>Rédiger</strong> pour écrire la connaissance ici.
            </p>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-1">
              {collections.map((c) => {
                const on = picked.some((r) => r.id === c.id);
                return (
                  <button
                    key={c.id} type="button" onClick={() => toggle(c)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                      on ? "bg-primary/10 text-foreground" : "hover:bg-muted/60",
                    )}
                  >
                    <span className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      on ? "border-primary bg-primary text-primary-foreground" : "border-border",
                    )}>
                      {on && <Check className="h-2.5 w-2.5" />}
                    </span>
                    <Library className="h-3 w-3 shrink-0 text-violet-400" />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-[10px] leading-snug text-muted-foreground/80">
            L'agent y cherchera ce dont il a besoin avec <code className="rounded bg-muted px-1">rag_search</code> —
            le contenu n'est pas chargé d'avance.
          </p>
          {written.trim() && (
            <DormantSide
              text="Un texte rédigé est conservé dans ce bloc — ignoré tant que le bloc pointe vers des collections."
              onClear={() => onPatch({ body: "", refs: refs.filter((r) => r.kind !== "text") })}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Content the active source does not compile. Saying so beats letting someone
 *  wonder why the text they wrote never reached the agent. */
function DormantSide({ text, onClear }: { text: string; onClear: () => void }) {
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[10px] leading-snug text-muted-foreground">
      <span className="min-w-0 flex-1">{text}</span>
      <button type="button" onClick={onClear} className="shrink-0 underline hover:text-destructive">Supprimer</button>
    </p>
  );
}

/** Attach knowledge to a step or a loop: existing collections, plus notes
 *  written on the spot. Both at once is fine here — unlike a context block, a
 *  step often needs the reference material AND a remark that applies to it
 *  alone. Files are deliberately absent: a collection already is where a file
 *  belongs. */
function ContextPicker({ refs, collections, onChange }: {
  refs: ContextRef[];
  collections: Array<{ id: string; name: string }>;
  onChange: (refs: ContextRef[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const used = new Set(refs.filter((r) => r.kind === "collection").map((r) => r.id));
  const free = collections.filter((c) => !used.has(c.id));

  return (
    <Field
      label="Connaissances à fournir"
      hint="Transmises à l'agent avec CETTE étape uniquement — c'est ainsi qu'on évite de recharger tout le contexte à chaque fois."
    >
      <div className="space-y-1.5">
        {refs.map((r, i) => {
          const patch = (p: Partial<ContextRef>) => onChange(refs.map((x, j) => (j === i ? { ...x, ...p } : x)));
          const open = expanded === i;
          return (
            <div key={i} className={cn(
              "overflow-hidden rounded-lg border bg-background",
              open ? "border-primary/40" : "border-border/60",
            )}>
              <div className="flex items-start gap-1.5 px-2 py-1.5">
                <span className={cn(
                  "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase",
                  r.kind === "collection" ? "bg-violet-400/15 text-violet-400" : "bg-sky-400/15 text-sky-400",
                )}>
                  {r.kind === "collection" ? "collection" : "procédure"}
                </span>
                {r.kind === "text" ? (
                  <input
                    value={r.label}
                    onChange={(e) => patch({ label: e.target.value })}
                    placeholder="Titre de la procédure"
                    className="min-w-0 flex-1 bg-transparent text-xs font-medium outline-none placeholder:text-muted-foreground/50"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{r.label}</span>
                )}
                {r.kind === "text" && (
                  <button
                    type="button" onClick={() => setExpanded(open ? null : i)}
                    title={open ? "Replier" : "Écrire la procédure"}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  ><Maximize2 className="h-3 w-3" /></button>
                )}
                <button
                  type="button" onClick={() => { onChange(refs.filter((_, j) => j !== i)); setExpanded(null); }}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                ><X className="h-3 w-3" /></button>
              </div>

              {r.kind === "text" && (
                <MarkdownEditor
                  variant="flush"
                  value={r.body ?? ""}
                  onChange={(v) => patch({ body: v })}
                  minHeight={open ? 320 : 96}
                  className="border-t border-border/50"
                  placeholder={"## Règles de rapprochement\n\n1. Écart accepté : 0,50 € par ligne.\n2. Au-delà, escalader au contrôleur de gestion.\n\nTransmis tel quel à l'agent."}
                  footer={open ? <span>Markdown — transmis intégralement à l'agent avec cette étape.</span> : undefined}
                />
              )}
              {r.kind === "collection" && (
                <p className="border-t border-border/50 px-2 py-1.5 text-[10px] text-muted-foreground">
                  L'agent la consultera avec <code className="rounded bg-muted px-1">rag_search</code>.
                </p>
              )}
            </div>
          );
        })}

        {adding ? (
          /* Two named choices rather than a dropdown sitting above a button:
             picking a collection and writing a note are different acts, and the
             mixed panel made the second one look like a fallback. */
          <div className="space-y-1.5 rounded-md border border-primary/40 bg-background p-2">
            {free.length > 0 ? (
              <>
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Choisir une collection</p>
                <div className="max-h-40 space-y-0.5 overflow-y-auto">
                  {free.map((c) => (
                    <button
                      key={c.id} type="button"
                      onClick={() => { onChange([...refs, { kind: "collection", id: c.id, label: c.name }]); setAdding(false); }}
                      className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] hover:bg-muted"
                    >
                      <Library className="h-3 w-3 shrink-0 text-violet-400" />
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                {collections.length === 0
                  ? "Aucune collection dans ce projet — ajoutez-en dans Ressources → Mémoire."
                  : "Toutes les collections du projet sont déjà rattachées."}
              </p>
            )}
            <div className="flex gap-1.5 border-t border-border/50 pt-1.5">
              <button
                type="button"
                onClick={() => { onChange([...refs, { kind: "text", label: "", body: "" }]); setExpanded(refs.length); setAdding(false); }}
                className="flex flex-1 items-center justify-center gap-1 rounded border border-border/60 px-2 py-1 text-[11px] hover:bg-muted"
              ><PenLine className="h-3 w-3" /> Rédiger une note</button>
              <button type="button" onClick={() => setAdding(false)} className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">Annuler</button>
            </div>
          </div>
        ) : (
          <button
            type="button" onClick={() => setAdding(true)}
            className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border/70 py-1.5 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
          >
            <Plus className="h-3 w-3" /> Ajouter du contexte
          </button>
        )}
      </div>
    </Field>
  );
}


