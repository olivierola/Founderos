-- Bake the "parallelize supplier sourcing per product" mandate into the
-- ecommerce-ops skill. The planner can't split sourcing upfront (it doesn't yet
-- know how many products exist — that's discovered mid-run after connecting the
-- store), so the fan-out has to be a mid-run decision. This makes it explicit &
-- non-optional whenever the agent reaches the sourcing step with N products in
-- hand. Idempotent: only appends if not already present. (agent_skills has no
-- updated_at column — do not set it.)

update public.agent_skills
set system_prompt_extension = system_prompt_extension || E'\n\nSOURCING FOURNISSEURS MULTI-PRODUITS (règle de parallélisation)\n- Sourcer des fournisseurs pour N produits = N recherches INDÉPENDANTES. Tu DOIS paralléliser : appelle spawn_parallel_agents avec UNE sous-tâche par produit (ou par catégorie homogène), une fois que tu connais la liste des produits. Ne source JAMAIS les produits un par un en séquentiel — c''est le principal gain de temps, et il n''y a pas de petit plafond (une sous-tâche par produit, des dizaines c''est ok).\n- Chaque sous-tâche cherche 2-3 fournisseurs et rend des données SOURCÉES par produit : prix unitaire, MOQ, délai de production, incoterm, et l''URL du fournisseur (web_search puis read_url sur Alibaba / Made-in-China / 1688). Si une recherche échoue, lis directement une URL de catégorie/recherche Made-in-China ou Alibaba avec read_url — ce fetch est fiable.\n- N''invente aucun prix : toute valeur non sourcée est étiquetée « hypothèse à valider par devis ». Après le fan-out, agrège les résultats de toutes les sous-tâches dans le plan de réapprovisionnement puis le rapport final.'
where workspace_id is null
  and slug = 'ecommerce-ops'
  and position('SOURCING FOURNISSEURS MULTI-PRODUITS' in system_prompt_extension) = 0;
