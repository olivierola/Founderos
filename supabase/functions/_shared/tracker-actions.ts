import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

/**
 * Qui agit dans le suivi de travail.
 *
 * Volontairement minimal : un client d'administration et l'identité de l'agent.
 * Passer le contexte complet d'un agent lierait ce module au moteur, alors
 * qu'une approbation validée trois heures plus tard n'a plus de contexte de
 * run à lui donner.
 */
export interface TrackerActor {
  admin: SupabaseClient;
  agentId: string;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/**
 * Le périmètre d'un agent : les projets où il a le droit d'agir, et son rôle.
 *
 * Une table vide veut dire AUCUN projet, jamais « tous » — c'est le défaut le
 * plus fermé, et le seul défendable pour un acteur automatique.
 */
export async function trackerScope(actor: TrackerActor): Promise<Map<string, string>> {
  const { data } = await actor.admin
    .from("pj_project_agents")
    .select("pj_project_id, role")
    .eq("agent_id", actor.agentId);
  return new Map(
    ((data ?? []) as Array<{ pj_project_id: string; role: string }>)
      .map((r) => [r.pj_project_id, r.role]),
  );
}

/**
 * L'exécution des actions du suivi de travail.
 *
 * Séparée de la déclaration de l'outil pour une raison pratique : c'est ce
 * corps que l'exécuteur d'approbations rejoue quand une personne valide une
 * écriture mise en attente. Le laisser dans la closure de `buildInternalToolset`
 * l'aurait rendu inatteignable depuis là, et on se serait retrouvé avec deux
 * implémentations à garder d'accord.
 *
 * Toutes les sorties sont du TEXTE court et lisible, pas du JSON brut. Un
 * modèle lit mieux « KABAK-7 · En cours · haute · échéance 12/09 » qu'un objet
 * de quinze champs dont il n'en utilisera que trois, et la différence se paie
 * en jetons à chaque tour.
 */
export async function runTrackerAction(
  ctx: TrackerActor,
  action: string,
  params: Record<string, unknown>,
  allowed: Map<string, string>,
): Promise<string> {
  const db = ctx.admin;
  const pid = str(params.project_id);
  const issueId = str(params.issue_id);

  const line = (i: Record<string, unknown>, prefix?: string): string => {
    const st = i.state as { name?: string; group?: string } | null;
    const bits = [
      `${prefix ?? ""}${i.identifier ?? ""}-${i.sequence_id ?? ""}`.trim(),
      String(i.name ?? ""),
      st?.name ? `état: ${st.name}` : null,
      i.priority && i.priority !== "none" ? `priorité: ${i.priority}` : null,
      i.target_date ? `échéance: ${i.target_date}` : null,
    ].filter(Boolean);
    return bits.join(" · ");
  };

  switch (action) {
    // ── Lectures ────────────────────────────────────────────────────────
    case "list_projects": {
      const ids = [...allowed.keys()];
      const { data } = await db.from("pj_projects")
        .select("id, name, identifier, description")
        .in("id", ids).is("archived_at", null);
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      if (!rows.length) return "Aucun projet ouvert.";
      return rows.map((r) =>
        `${r.identifier} · ${r.name} (id: ${r.id}, rôle: ${allowed.get(String(r.id))})`
        + (r.description ? `\n   ${String(r.description).slice(0, 160)}` : "")).join("\n");
    }

    case "my_work": {
      const { data } = await db.rpc("pj_agent_work", { p_agent: ctx.agentId });
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      if (!rows.length) return "Rien ne t'est assigné pour l'instant.";
      // Les terminés sont comptés mais pas listés : ils n'appellent aucune
      // action, et les lister à chaque tour coûte des jetons pour rien.
      const open = rows.filter((r) => !r.completed_at);
      const done = rows.length - open.length;
      const body = open.map((r) =>
        `${r.identifier}-${r.sequence_id} · ${r.name} · état: ${r.state_name ?? "—"}`
        + (r.priority && r.priority !== "none" ? ` · priorité: ${r.priority}` : "")
        + (r.target_date ? ` · échéance: ${r.target_date}` : "")
        + ` (issue_id: ${r.issue_id})`).join("\n");
      return `${open.length} en cours${done ? `, ${done} terminé(s)` : ""}.\n${body}`;
    }

    case "list_work_items": {
      if (!pid) return "ERREUR : project_id manquant.";
      let q = db.from("pj_issues")
        .select("id, name, sequence_id, priority, target_date, state_id, completed_at")
        .eq("pj_project_id", pid).is("archived_at", null).eq("is_draft", false)
        .order("updated_at", { ascending: false })
        .limit(Math.min(Number(params.limit) || 30, 100));
      if (params.priority) q = q.eq("priority", str(params.priority));
      const { data } = await q;
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      if (!rows.length) return "Aucun work item dans ce projet.";

      const { data: proj } = await db.from("pj_projects").select("identifier").eq("id", pid).maybeSingle();
      const { data: states } = await db.from("pj_states").select("id, name, \"group\"").eq("pj_project_id", pid);
      const byState = new Map(((states ?? []) as Array<Record<string, unknown>>).map((x) => [x.id, x]));

      let list = rows;
      const group = str(params.state_group);
      if (group) list = rows.filter((r) => (byState.get(r.state_id) as { group?: string })?.group === group);

      return list.map((r) => line({
        ...r,
        identifier: (proj as { identifier?: string })?.identifier,
        state: byState.get(r.state_id) ?? null,
      }) + ` (issue_id: ${r.id})`).join("\n") || "Rien ne correspond.";
    }

    case "get_work_item": {
      if (!issueId) return "ERREUR : issue_id manquant.";
      const { data } = await db.from("pj_issues").select("*").eq("id", issueId).maybeSingle();
      if (!data) return "Work item introuvable.";
      const i = data as Record<string, unknown>;
      if (!allowed.has(String(i.pj_project_id))) {
        return "ERREUR : ce work item est hors de ton périmètre.";
      }
      const { data: st } = await db.from("pj_states").select("name, \"group\"").eq("id", i.state_id).maybeSingle();
      const { data: comments } = await db.from("pj_issue_comments")
        .select("comment_html, created_at").eq("issue_id", issueId)
        .order("created_at", { ascending: false }).limit(5);

      return [
        `Nom : ${i.name}`,
        `État : ${(st as { name?: string })?.name ?? "—"}`,
        `Priorité : ${i.priority}`,
        i.start_date ? `Début : ${i.start_date}` : null,
        i.target_date ? `Échéance : ${i.target_date}` : null,
        i.description_text ? `\nDescription :\n${String(i.description_text).slice(0, 2000)}` : null,
        (comments ?? []).length
          ? `\nDerniers commentaires :\n` + ((comments ?? []) as Array<Record<string, unknown>>)
              .map((c) => `- ${String(c.comment_html ?? "").replace(/<[^>]+>/g, "").slice(0, 200)}`).join("\n")
          : null,
      ].filter(Boolean).join("\n");
    }

    case "search": {
      const query = str(params.query);
      if (!query) return "ERREUR : query manquante.";
      const { data } = await db.from("pj_issues")
        .select("id, name, sequence_id, pj_project_id")
        .in("pj_project_id", [...allowed.keys()])
        .ilike("name", `%${query}%`)
        .is("archived_at", null)
        .limit(Math.min(Number(params.limit) || 20, 50));
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      return rows.length
        ? rows.map((r) => `${r.name} (issue_id: ${r.id})`).join("\n")
        : "Aucun résultat.";
    }

    case "list_states": {
      if (!pid) return "ERREUR : project_id manquant.";
      const { data } = await db.from("pj_states")
        .select("id, name, \"group\"").eq("pj_project_id", pid).order("sort_order");
      return ((data ?? []) as Array<Record<string, unknown>>)
        .map((r) => `${r.name} (${r.group}) — state_id: ${r.id}`).join("\n") || "Aucun état.";
    }

    case "list_cycles": {
      if (!pid) return "ERREUR : project_id manquant.";
      const { data } = await db.from("pj_cycles")
        .select("id, name, start_date, end_date").eq("pj_project_id", pid).is("archived_at", null);
      return ((data ?? []) as Array<Record<string, unknown>>)
        .map((r) => `${r.name} · ${r.start_date ?? "?"} → ${r.end_date ?? "?"} (cycle_id: ${r.id})`)
        .join("\n") || "Aucun cycle.";
    }

    case "list_modules": {
      if (!pid) return "ERREUR : project_id manquant.";
      const { data } = await db.from("pj_modules")
        .select("id, name, status").eq("pj_project_id", pid).is("archived_at", null);
      return ((data ?? []) as Array<Record<string, unknown>>)
        .map((r) => `${r.name} · ${r.status} (module_id: ${r.id})`).join("\n") || "Aucun module.";
    }

    // ── Écritures ───────────────────────────────────────────────────────
    case "create_work_item": {
      if (!pid) return "ERREUR : project_id manquant.";
      const name = str(params.name);
      if (!name) return "ERREUR : name manquant.";

      const { data: proj } = await db.from("pj_projects")
        .select("workspace_id, identifier").eq("id", pid).maybeSingle();
      if (!proj) return "Projet introuvable.";

      let stateId = str(params.state_id) || null;
      if (!stateId) {
        const { data: def } = await db.from("pj_states").select("id")
          .eq("pj_project_id", pid).eq("is_default", true).maybeSingle();
        stateId = (def as { id?: string })?.id ?? null;
      }

      const { data, error } = await db.from("pj_issues").insert({
        pj_project_id: pid,
        workspace_id: (proj as { workspace_id: string }).workspace_id,
        name,
        description_text: str(params.description),
        description_html: str(params.description),
        priority: str(params.priority) || "none",
        state_id: stateId,
        target_date: params.target_date ? str(params.target_date) : null,
      }).select("id, sequence_id").single();
      if (error) return `ERREUR : ${error.message}`;

      const created = data as { id: string; sequence_id: number };
      // L'agent s'assigne ce qu'il crée. Sans ça, il produirait du travail
      // orphelin dont personne — lui compris — ne se sait responsable.
      await db.from("pj_issue_agents").insert({
        issue_id: created.id,
        agent_id: ctx.agentId,
        workspace_id: (proj as { workspace_id: string }).workspace_id,
      });

      return `Créé : ${(proj as { identifier: string }).identifier}-${created.sequence_id} `
        + `« ${name} » (issue_id: ${created.id}). Il t'est assigné.`;
    }

    case "update_work_item": {
      if (!issueId) return "ERREUR : issue_id manquant.";
      const { data: cur } = await db.from("pj_issues")
        .select("pj_project_id").eq("id", issueId).maybeSingle();
      if (!cur) return "Work item introuvable.";
      if (!allowed.has(String((cur as { pj_project_id: string }).pj_project_id))) {
        return "ERREUR : ce work item est hors de ton périmètre.";
      }

      const patch: Record<string, unknown> = {};
      for (const k of ["name", "priority", "state_id", "start_date", "target_date"]) {
        if (params[k] !== undefined) patch[k] = params[k] === "" ? null : params[k];
      }

      // L'état par son GROUPE plutôt que par son identifiant.
      //
      // Un agent qui a fini veut dire « terminé », pas retrouver l'UUID de
      // l'état qui porte ce sens dans CE projet — chaque projet nomme les siens
      // (« Livré », « Done », « Validé »). Lui imposer list_states puis un
      // identifiant, c'était deux appels et une occasion de se tromper de ligne
      // pour le seul geste qu'on attend de lui en fin de travail. Le groupe est
      // le vocabulaire commun à tous les projets ; on résout ici, côté serveur.
      if (params.state_group !== undefined && patch.state_id === undefined) {
        const group = str(params.state_group);
        const GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"];
        if (!GROUPS.includes(group)) {
          return `ERREUR : state_group doit valoir ${GROUPS.join(", ")}.`;
        }
        const { data: st } = await db.from("pj_states")
          .select("id, name")
          .eq("pj_project_id", (cur as { pj_project_id: string }).pj_project_id)
          .eq("group", group)
          .order("sequence", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (!st) return `ERREUR : ce projet n'a aucun état dans le groupe « ${group} ».`;
        patch.state_id = (st as { id: string }).id;
      }

      if (params.description !== undefined) {
        patch.description_text = str(params.description);
        patch.description_html = str(params.description);
      }
      if (!Object.keys(patch).length) return "Rien à modifier.";

      patch.updated_at = new Date().toISOString();
      const { error } = await db.from("pj_issues").update(patch).eq("id", issueId);
      if (error) return `ERREUR : ${error.message}`;
      return `Mis à jour : ${Object.keys(patch).filter((k) => k !== "updated_at").join(", ")}.`;
    }

    // ── Organiser le travail ────────────────────────────────────────────
    //
    // Un agent qui ne peut que cocher des tâches n'est pas un membre de
    // l'équipe : c'est un exécutant. Organiser — découper un sujet, ouvrir un
    // cycle, regrouper dans un module, poser des dates — est ce qui sépare les
    // deux, et c'est aussi ce qu'on lui demande quand on lui confie un projet
    // plutôt qu'une tâche.
    //
    // Toutes ces écritures passent par le même périmètre que les autres
    // (`allowed`), et toutes sont soumises à approbation comme n'importe quelle
    // écriture : l'agent gagne la capacité, pas le droit de s'en servir sans
    // qu'on regarde.

    case "create_cycle": {
      if (!pid) return "ERREUR : project_id manquant.";
      const name = str(params.name);
      if (!name) return "ERREUR : name manquant.";
      const { data: proj } = await db.from("pj_projects")
        .select("workspace_id").eq("id", pid).maybeSingle();
      if (!proj) return "Projet introuvable.";

      const { data, error } = await db.from("pj_cycles").insert({
        pj_project_id: pid,
        workspace_id: (proj as { workspace_id: string }).workspace_id,
        name,
        description: str(params.description),
        start_date: params.start_date ? str(params.start_date) : null,
        end_date: params.end_date ? str(params.end_date) : null,
      }).select("id, name").single();
      if (error) return `ERREUR : ${error.message}`;
      const c = data as { id: string; name: string };
      return `Cycle créé : « ${c.name} » (cycle_id: ${c.id}).`;
    }

    case "create_module": {
      if (!pid) return "ERREUR : project_id manquant.";
      const name = str(params.name);
      if (!name) return "ERREUR : name manquant.";
      const { data: proj } = await db.from("pj_projects")
        .select("workspace_id").eq("id", pid).maybeSingle();
      if (!proj) return "Projet introuvable.";

      const { data, error } = await db.from("pj_modules").insert({
        pj_project_id: pid,
        workspace_id: (proj as { workspace_id: string }).workspace_id,
        name,
        description: str(params.description),
        status: str(params.status) || "planned",
        start_date: params.start_date ? str(params.start_date) : null,
        target_date: params.target_date ? str(params.target_date) : null,
      }).select("id, name").single();
      if (error) return `ERREUR : ${error.message}`;
      const m = data as { id: string; name: string };
      return `Module créé : « ${m.name} » (module_id: ${m.id}).`;
    }

    case "plan_work_item": {
      // Ranger un item : dans un cycle, dans des modules, sous un parent, avec
      // ses dates. UNE action et non quatre, parce que c'est UN geste — on
      // planifie un item, on ne le range pas quatre fois de suite.
      if (!issueId) return "ERREUR : issue_id manquant.";
      const { data: cur } = await db.from("pj_issues")
        .select("pj_project_id, workspace_id").eq("id", issueId).maybeSingle();
      if (!cur) return "Work item introuvable.";
      const c = cur as { pj_project_id: string; workspace_id: string };
      if (!allowed.has(c.pj_project_id)) {
        return "ERREUR : ce work item est hors de ton périmètre.";
      }

      const done: string[] = [];

      if (params.cycle_id !== undefined) {
        const cycleId = str(params.cycle_id);
        // Un item n'appartient qu'à UN cycle : on remplace, on n'empile pas.
        await db.from("pj_cycle_issues").delete().eq("issue_id", issueId);
        if (cycleId) {
          const { error } = await db.from("pj_cycle_issues").insert({
            issue_id: issueId, cycle_id: cycleId, workspace_id: c.workspace_id,
          });
          if (error) return `ERREUR : ${error.message}`;
          done.push("cycle");
        } else done.push("cycle retiré");
      }

      if (Array.isArray(params.module_ids)) {
        await db.from("pj_module_issues").delete().eq("issue_id", issueId);
        const ids = (params.module_ids as unknown[]).map(String).filter(Boolean);
        if (ids.length) {
          const { error } = await db.from("pj_module_issues").insert(
            ids.map((module_id) => ({
              issue_id: issueId, module_id, workspace_id: c.workspace_id,
            })),
          );
          if (error) return `ERREUR : ${error.message}`;
        }
        done.push(`${ids.length} module(s)`);
      }

      const patch: Record<string, unknown> = {};
      for (const k of ["start_date", "target_date", "parent_id"]) {
        if (params[k] !== undefined) patch[k] = params[k] === "" ? null : params[k];
      }
      if (Object.keys(patch).length) {
        patch.updated_at = new Date().toISOString();
        const { error } = await db.from("pj_issues").update(patch).eq("id", issueId);
        if (error) return `ERREUR : ${error.message}`;
        done.push(Object.keys(patch).filter((k) => k !== "updated_at").join(", "));
      }

      return done.length ? `Planifié : ${done.join(" · ")}.` : "Rien à planifier.";
    }

    case "break_down": {
      // Découper un sujet en sous-items. C'est le geste d'organisation le plus
      // fréquent, et le faire en un appel plutôt qu'en N créations évite qu'un
      // agent s'arrête au milieu d'un découpage à moitié écrit.
      if (!issueId) return "ERREUR : issue_id manquant.";
      const titles = Array.isArray(params.titles)
        ? (params.titles as unknown[]).map(String).map((t) => t.trim()).filter(Boolean)
        : [];
      if (!titles.length) return "ERREUR : titles manquant (liste de sous-tâches).";

      const { data: cur } = await db.from("pj_issues")
        .select("pj_project_id, workspace_id, state_id").eq("id", issueId).maybeSingle();
      if (!cur) return "Work item introuvable.";
      const c = cur as { pj_project_id: string; workspace_id: string; state_id: string | null };
      if (!allowed.has(c.pj_project_id)) {
        return "ERREUR : ce work item est hors de ton périmètre.";
      }

      const { data: def } = await db.from("pj_states").select("id")
        .eq("pj_project_id", c.pj_project_id).eq("is_default", true).maybeSingle();

      const { data, error } = await db.from("pj_issues").insert(
        titles.slice(0, 20).map((name) => ({
          pj_project_id: c.pj_project_id,
          workspace_id: c.workspace_id,
          name,
          parent_id: issueId,
          state_id: (def as { id?: string })?.id ?? c.state_id,
        })),
      ).select("id, sequence_id, name");
      if (error) return `ERREUR : ${error.message}`;

      const rows = (data ?? []) as Array<{ sequence_id: number; name: string }>;
      return `Découpé en ${rows.length} sous-item(s) :\n`
        + rows.map((r) => `- ${r.sequence_id} · ${r.name}`).join("\n");
    }

    case "comment": {
      if (!issueId) return "ERREUR : issue_id manquant.";
      const body = str(params.body);
      if (!body) return "ERREUR : body manquant.";
      const { data: cur } = await db.from("pj_issues")
        .select("pj_project_id, workspace_id").eq("id", issueId).maybeSingle();
      if (!cur) return "Work item introuvable.";
      const row = cur as { pj_project_id: string; workspace_id: string };
      if (!allowed.has(row.pj_project_id)) return "ERREUR : hors périmètre.";

      // Le NOM de l'agent est figé dans la ligne, pas seulement son
      // identifiant : un agent peut être renommé, et un fil doit rester
      // lisible tel qu'il a été écrit.
      const { data: me } = await db.from("internal_agents")
        .select("name").eq("id", ctx.agentId).maybeSingle();

      const { error } = await db.from("pj_issue_comments").insert({
        issue_id: issueId,
        // Obligatoire en base (not null) : sans lui l'insertion échoue sur la
        // contrainte, et l'agent reçoit une erreur qu'il ne peut pas corriger.
        pj_project_id: row.pj_project_id,
        workspace_id: row.workspace_id,
        // Signé par l'AGENT, jamais par une personne : un commentaire de
        // machine attribué à un humain est un faux, et fait perdre la
        // confiance dans tout le journal.
        agent_id: ctx.agentId,
        agent_name: (me as { name?: string } | null)?.name ?? null,
        comment_html: body,
      });
      if (error) return `ERREUR : ${error.message}`;
      return "Commentaire publié.";
    }

    case "assign_self":
    case "unassign_self": {
      if (!issueId) return "ERREUR : issue_id manquant.";
      const { data: cur } = await db.from("pj_issues")
        .select("pj_project_id, workspace_id").eq("id", issueId).maybeSingle();
      if (!cur) return "Work item introuvable.";
      const row = cur as { pj_project_id: string; workspace_id: string };
      if (!allowed.has(row.pj_project_id)) return "ERREUR : hors périmètre.";

      if (action === "unassign_self") {
        await db.from("pj_issue_agents").delete()
          .eq("issue_id", issueId).eq("agent_id", ctx.agentId);
        return "Tu n'es plus assigné à ce work item.";
      }
      const { error } = await db.from("pj_issue_agents").insert({
        issue_id: issueId, agent_id: ctx.agentId, workspace_id: row.workspace_id,
      });
      // Doublon : ce n'est pas une erreur, l'état voulu est déjà atteint.
      if (error && !String(error.message).includes("duplicate")) {
        return `ERREUR : ${error.message}`;
      }
      return "Tu es assigné à ce work item.";
    }

    default:
      return `ERREUR : action inconnue « ${action} ».`;
  }
}
