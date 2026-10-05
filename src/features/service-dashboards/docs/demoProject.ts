import { supabase } from "@/lib/supabase";
import {
  createIssue, createLabel,
  createPage, createProject, createSticky, createView, fetchStates,
  updateSticky,
  type PjIssue, type PjState,
} from "@/features/tracker/model";

/**
 * Le projet de démonstration.
 *
 * Il existe pour la documentation, et cela dicte tout ce qui suit.
 *
 * Un manuel illustré de captures d'écran vieillit mal : l'interface bouge, les
 * images restent, et le lecteur finit par se demander laquelle des deux ment.
 * Un manuel qu'on peut PARCOURIR dans son propre espace ne vieillit pas — le
 * lecteur ouvre l'écran dont on lui parle, avec des données dedans, et vérifie
 * lui-même. D'où ce semeur : il fabrique un projet plausible, assez fourni pour
 * que chaque page du module ait quelque chose à montrer.
 *
 * « Plausible » est le mot important. Un jeu d'essai fait de « Tâche 1, Tâche
 * 2, Tâche 3 » n'apprend rien : tous les écrans y ont l'air identiques, aucun
 * regroupement ne veut dire quoi que ce soit, et les colonnes vides passent
 * pour des bogues. Les données ci-dessous racontent donc un vrai projet — une
 * refonte de portail client — avec ses urgences, ses retards, ses sujets qui
 * traînent en backlog et ses demandes non triées.
 *
 * Rien n'est marqué « démo » en base : c'est un projet ordinaire, qui se
 * modifie et se supprime comme les autres. Le déguiser en objet spécial aurait
 * demandé de le traiter à part partout, pour le seul bénéfice d'un bandeau.
 */

/** Une date relative à aujourd'hui, au format ISO court. */
function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** L'état d'un groupe donné, ou le premier venu. Les projets neufs portent les
 *  cinq états semés par le déclencheur de 0221. */
function stateOf(states: PjState[], group: PjState["group"]): string | null {
  return states.find((s) => s.group === group)?.id ?? states[0]?.id ?? null;
}

export interface DemoResult {
  projectId: string;
  identifier: string;
  counts: { issues: number; pages: number; stickies: number };
}

export async function seedDemoProject(input: {
  workspaceId: string;
  projectId: string;
  dashboardId: string;
  userId: string | null;
}): Promise<DemoResult> {
  const { workspaceId, dashboardId, userId } = input;

  const project = await createProject({
    workspaceId,
    projectId: input.projectId,
    dashboardId,
    name: "Refonte du portail client",
    identifier: `DEMO${Math.floor(Math.random() * 90 + 10)}`,
    description:
      "Projet de démonstration. Il contient de quoi parcourir chaque écran du module avec des données réelles : work items répartis sur tous les états, des pages et des notes.",
    logo_props: { in_use: "emoji", emoji: { value: "🛠️" } },
    createdBy: userId,
  });

  const states = await fetchStates(project.id);
  const backlog = stateOf(states, "backlog");
  const todo = stateOf(states, "unstarted");
  const doing = stateOf(states, "started");
  const done = stateOf(states, "completed");
  const cancelled = stateOf(states, "cancelled");

  // ── Labels ────────────────────────────────────────────────────────────────
  const labelSpecs = [
    { name: "Design", color: "#a855f7" },
    { name: "Backend", color: "#0ea5e9" },
    { name: "Frontend", color: "#22c55e" },
    { name: "Bug", color: "#ef4444" },
    { name: "Recherche utilisateur", color: "#f59e0b" },
  ];
  const labels: Record<string, string> = {};
  for (const spec of labelSpecs) {
    const l = await createLabel({ pjProjectId: project.id, workspaceId, ...spec });
    labels[spec.name] = l.id;
  }

  // ── Work items ────────────────────────────────────────────────────────────
  // La répartition est volontairement DÉSÉQUILIBRÉE : du travail terminé, du
  // travail en cours, une file d'attente plus grosse que le reste, un item
  // annulé et un item en retard. Un jeu d'essai réparti à parts égales entre
  // les cinq états ne ressemble à aucun projet réel, et les écrans qui servent
  // justement à repérer un déséquilibre n'y montrent rien.
  const spec: Array<{
    name: string;
    state: string | null;
    priority?: PjIssue["priority"];
    labels?: string[];
    start?: string;
    target?: string;
    description?: string;
    children?: string[];
  }> = [
    {
      name: "Connexion par lien magique",
      state: done, priority: "high", labels: ["Backend"], start: day(-9), target: day(-3),
      description: "Remplacer le couple identifiant/mot de passe par un lien à usage unique envoyé par courriel.",
      children: ["Envoi du courriel transactionnel", "Expiration du lien après 15 minutes"],
    },
    {
      name: "Écran « mot de passe oublié » inaccessible au clavier",
      state: doing, priority: "urgent", labels: ["Bug", "Frontend"], target: day(-1),
      description: "Le piège de focus de la modale enferme la navigation au clavier. Signalé par deux clients.",
    },
    {
      name: "Design system : jetons de couleur et typographie",
      state: done, priority: "medium", labels: ["Design"],
      start: day(-9), target: day(-5),
    },
    {
      name: "Squelette du tableau de bord",
      state: doing, priority: "high", labels: ["Frontend"], start: day(-4), target: day(3),
      children: ["Grille responsive", "États de chargement"],
    },
    {
      name: "Widget « consommation du mois »",
      state: todo, priority: "medium", labels: ["Frontend", "Design"], target: day(4),
    },
    {
      name: "Endpoint d'agrégation de l'usage",
      state: doing, priority: "high", labels: ["Backend"], target: day(2),
    },
    {
      name: "Historique des factures",
      state: todo, priority: "medium", labels: ["Frontend"], start: day(6), target: day(12),
    },
    {
      name: "Téléchargement du PDF de facture",
      state: todo, priority: "medium", labels: ["Backend"], start: day(8), target: day(15),
    },
    {
      name: "Ajouter un moyen de paiement",
      state: todo, priority: "high", labels: ["Frontend", "Backend"], start: day(10), target: day(19),
    },
    {
      name: "Relance automatique des impayés",
      state: backlog, priority: "low", labels: ["Backend"],
      description: "À cadrer avec le juridique avant d'être planifié.",
    },
    {
      name: "Entretiens utilisateurs, 5 clients grands comptes",
      state: done, priority: "high", labels: ["Recherche utilisateur"],
      start: day(-14), target: day(-7),
    },
    {
      name: "Synthèse des entretiens et arbitrages",
      state: todo, priority: "medium", labels: ["Recherche utilisateur", "Design"],
      target: day(7),
    },
    {
      name: "Mode sombre du portail",
      state: backlog, priority: "low", labels: ["Design", "Frontend"],
    },
    {
      name: "Export CSV de l'historique de consommation",
      state: backlog, priority: "none", labels: ["Backend"],
    },
    {
      name: "Migration vers la nouvelle API de facturation",
      state: backlog, priority: "medium", labels: ["Backend"],
    },
    {
      name: "Notifications par SMS",
      state: cancelled, priority: "low",
      description: "Abandonné : le coût par message ne se justifie pas au volume actuel.",
    },
    {
      name: "Audit d'accessibilité RGAA",
      state: backlog, priority: "medium", labels: ["Design"],
    },
  ];

  let issueCount = 0;
  for (const s of spec) {
    const issue = await createIssue({
      pjProjectId: project.id,
      workspaceId,
      name: s.name,
      description_text: s.description ?? "",
      description_html: s.description ?? "",
      priority: s.priority ?? "none",
      state_id: s.state,
      start_date: s.start ?? null,
      target_date: s.target ?? null,
      label_ids: (s.labels ?? []).map((n) => labels[n]).filter(Boolean),
      assignee_ids: userId ? [userId] : [],
      createdBy: userId,
    });
    issueCount += 1;

    // Les sous-items servent la page Work items (hiérarchie) et la fiche d'un
    // item (bloc « Sous-items »). Deux suffisent à montrer le motif.
    for (const child of s.children ?? []) {
      await createIssue({
        pjProjectId: project.id, workspaceId, name: child,
        parent_id: issue.id, state_id: s.state === done ? done : todo,
        priority: "medium", createdBy: userId,
      });
      issueCount += 1;
    }
  }

  // ── Pages ─────────────────────────────────────────────────────────────────
  const pages = [
    "Décisions d'architecture",
    "Compte rendu des entretiens clients",
    "Checklist de mise en production",
  ];
  for (const name of pages) {
    await createPage({ pjProjectId: project.id, workspaceId, name, ownedBy: userId });
  }

  // ── Vue ───────────────────────────────────────────────────────────────────
  // Une vue enregistrée montre à quoi servent les filtres : la même liste,
  // restreinte à ce qui demande une décision aujourd'hui.
  await createView({
    pjProjectId: project.id, workspaceId,
    name: "Urgences en cours",
    description: "Les items urgents ou hauts qui ne sont pas terminés.",
    filters: { priority: ["urgent", "high"], state_group: ["started", "unstarted"] },
    display_filters: { group_by: "priority", order_by: "-created_at", type: "all", sub_issue: true },
    display_properties: {},
    ownedBy: userId,
  });

  // ── Stickies ──────────────────────────────────────────────────────────────
  // Elles vivent au niveau du SERVICE et non du projet : c'est le mur de notes
  // du tableau, pas un champ du projet.
  const notes = [
    { text: "Relancer le juridique sur les relances d'impayés", color: "#fef3c7" },
    { text: "Démo portail, jeudi 14 h avec l'équipe support", color: "#dbeafe" },
    { text: "Vérifier le budget SMS avant de rouvrir le sujet", color: "#fce7f3" },
  ];
  let stickyCount = 0;
  for (const n of notes) {
    if (!userId) break;
    const s = await createSticky({ workspaceId, dashboardId, userId, color: n.color });
    await updateSticky(s.id, { content: n.text });
    stickyCount += 1;
  }

  return {
    projectId: project.id,
    identifier: project.identifier,
    counts: {
      issues: issueCount, pages: pages.length, stickies: stickyCount,
    },
  };
}

/**
 * Les projets de démonstration déjà semés dans ce tableau.
 *
 * Sert à dire « vous en avez déjà un » plutôt qu'à en empiler cinq : la
 * reconnaissance passe par la description, seule marque que le semeur laisse,
 * parce qu'aucune colonne de la table ne distingue un projet de démonstration
 * d'un autre — et qu'en ajouter une pour ça aurait fait porter à tout le
 * produit une notion qui n'intéresse que ce fichier.
 */
export async function findDemoProjects(dashboardId: string): Promise<Array<{ id: string; name: string }>> {
  const { data } = await supabase
    .from("pj_projects")
    .select("id, name, description")
    .eq("dashboard_id", dashboardId)
    .ilike("description", "Projet de démonstration.%");
  return (data ?? []) as Array<{ id: string; name: string }>;
}
