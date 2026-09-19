-- Le déclencheur CRM ne choisit plus sa table cible — correctif FOS-05 (+ FOS-17).
--
-- CE QUI N'ALLAIT PAS
-- `crm_sync_to_source()` est `security definer` : elle s'exécute avec les droits
-- du propriétaire de la base et ignore RLS. Sa dernière instruction était
--
--     execute format('update public.%I set %s where id = %L',
--                    v_obj.source_table, v_sets, new.source_id);
--
-- où `v_obj` venait de la ligne `crm_objects` — dont `source_table` et
-- `source_title_col` sont deux colonnes de texte libre, écrites par n'importe
-- quel membre du workspace (politique `for all` de la migration 0071).
--
-- Les identifiants sont bien échappés par %I et %L : il n'y avait pas
-- d'injection SQL. Le défaut est plus simple et plus grave — la CIBLE de la
-- mise à jour était choisie par l'utilisateur. En trois requêtes depuis le
-- navigateur, avec la clé anon :
--
--   1. crm_objects  ← source_table='workspace_members', source_title_col='role'
--   2. crm_records  ← source_id = <ligne d'appartenance d'un AUTRE workspace>
--   3. update crm_records set data = '{"name":"owner"}'
--   → update public.workspace_members set role='owner' where id=…
--
-- La même primitive visait founder_api_keys.key_hash, ops_settings.
-- runner_token_hash, subscriptions, internal_agents.instructions…
--
-- LE CORRECTIF
-- La table cible et la colonne titre sont désormais résolues depuis
-- `crm_source_catalog`, en joignant sur le `slug` de l'objet. Ce catalogue est
-- la référence de confiance : il est peuplé par les migrations et la 0150 l'a
-- mis en lecture seule pour les rôles API (aucune politique d'écriture, donc
-- anon et authenticated ne peuvent pas le modifier). Les colonnes
-- `source_table` / `source_title_col` de `crm_objects` ne sont plus jamais lues
-- par du code privilégié — elles ne servent plus qu'à l'affichage.
--
-- Trois verrous, pas un :
--   1. cible résolue depuis le catalogue, pas depuis la ligne utilisateur ;
--   2. un déclencheur BEFORE qui recale ces deux colonnes sur le catalogue à
--      chaque écriture, pour qu'elles ne puissent plus mentir ;
--   3. la ligne source visée doit appartenir au même projet que l'enregistrement
--      CRM — un objet légitime ne peut donc pas servir à écrire chez le voisin.
--
-- `set search_path` est ajouté au passage (FOS-17) : une fonction definer qui
-- laisse la résolution de noms ouverte est détournable dès qu'un rôle obtient
-- le droit de créer des objets dans un schéma du chemin de recherche.

-- ── 1. Recaler source_table / source_title_col sur le catalogue ──────────────
-- Défense en profondeur : même si un futur appelant relit ces colonnes, elles
-- ne peuvent plus contenir que ce que le catalogue autorise. Un slug hors
-- catalogue donne un objet natif (NULL/NULL), ce qui est le comportement des
-- objets créés par crm_seed_project.
create or replace function public.crm_objects_pin_source()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare c record;
begin
  select source_table, title_col into c
  from public.crm_source_catalog where slug = new.slug;

  if c.source_table is null then
    new.source_table := null;
    new.source_title_col := null;
  else
    new.source_table := c.source_table;
    new.source_title_col := c.title_col;
  end if;
  return new;
end $$;

drop trigger if exists trg_crm_objects_pin_source on public.crm_objects;
create trigger trg_crm_objects_pin_source
  before insert or update on public.crm_objects
  for each row execute function public.crm_objects_pin_source();

-- Remise en état des lignes existantes : celles dont source_table ne correspond
-- pas au catalogue sont soit un détournement, soit une dérive de données.
update public.crm_objects o
   set source_table     = c.source_table,
       source_title_col = c.title_col
  from public.crm_source_catalog c
 where c.slug = o.slug
   and (o.source_table is distinct from c.source_table
     or o.source_title_col is distinct from c.title_col);

update public.crm_objects o
   set source_table = null, source_title_col = null
 where o.source_table is not null
   and not exists (select 1 from public.crm_source_catalog c where c.slug = o.slug);

-- ── 2. Synchro inverse : cible prise dans le catalogue ───────────────────────
create or replace function public.crm_sync_to_source()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_obj record; v_cat record; p record; v_val text;
  v_sets text := '';
  v_title_generated boolean := false;
  v_belongs boolean;
begin
  if current_setting('crm.syncing', true) = '1' then return new; end if;
  if new.source_id is null then return new; end if;

  -- Le slug et le projet viennent de l'objet ; la TABLE vient du catalogue.
  select slug, project_id into v_obj
  from public.crm_objects where id = new.object_id;
  if v_obj.slug is null then return new; end if;

  select source_table, title_col into v_cat
  from public.crm_source_catalog where slug = v_obj.slug;
  -- Objet natif (EAV) : rien à répercuter, c'est le cas normal.
  if v_cat.source_table is null then return new; end if;

  -- L'enregistrement CRM et la ligne source doivent vivre dans le même projet.
  -- Sans ce contrôle, un objet parfaitement légitime suffirait à écrire dans la
  -- ligne d'un autre client, puisque source_id reste libre.
  execute format(
    'select exists (select 1 from public.%I where id = $1 and project_id = $2)',
    v_cat.source_table
  ) into v_belongs using new.source_id, v_obj.project_id;
  if not v_belongs then return new; end if;

  -- Colonne titre générée ? (elle ne peut pas être mise à jour)
  select (is_generated <> 'NEVER') into v_title_generated
  from information_schema.columns
  where table_schema = 'public'
    and table_name = v_cat.source_table
    and column_name = v_cat.title_col;

  if coalesce(v_title_generated, false) = false and (new.data ? 'name') then
    v_sets := format('%I = %L', v_cat.title_col, new.data->>'name');
  end if;

  -- Colonnes mappées inscriptibles, elles aussi déclarées côté catalogue.
  for p in select key, source_col, type from public.crm_source_props
           where object_slug = v_obj.slug and writable loop
    if new.data ? p.key then
      v_val := new.data->>p.key;
      if p.type = 'checkbox' then
        v_sets := v_sets || case when v_sets = '' then '' else ', ' end
                || format('%I = %L', p.source_col, (v_val = 'true'));
      else
        v_sets := v_sets || case when v_sets = '' then '' else ', ' end
                || format('%I = %L', p.source_col, v_val);
      end if;
    end if;
  end loop;

  if v_sets = '' then return new; end if;
  perform set_config('crm.syncing', '1', true);
  execute format('update public.%I set %s where id = %L and project_id = %L',
                 v_cat.source_table, v_sets, new.source_id, v_obj.project_id);
  perform set_config('crm.syncing', '0', true);
  return new;
end $$;

-- ── 3. Les autres fonctions definer du module CRM ───────────────────────────
-- Même défaut de search_path (FOS-17). Elles lisent `source_table` depuis le
-- catalogue, qu'elles interrogent déjà par slug — seul le search_path manquait.
-- Signatures tolérantes : ces fonctions ont été redéfinies plusieurs fois au fil
-- des migrations 0071-0085, et une signature qui a bougé ne doit pas faire
-- échouer un correctif de sécurité. On boucle sur le catalogue système.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef                                   -- security definer seulement
      and p.proname in ('crm_seed_project', 'crm_add_from_catalog',
                        'crm_sync_from_source', 'crm_link_relations')
      and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path%'
  loop
    execute format('alter function %s set search_path = public, pg_catalog', f.sig);
  end loop;
end $$;

comment on function public.crm_sync_to_source() is
  'Synchro CRM → table source. La table cible vient de crm_source_catalog (lecture seule pour les rôles API), jamais de la ligne crm_objects que l''utilisateur contrôle. Correctif FOS-05.';
comment on function public.crm_objects_pin_source() is
  'Force crm_objects.source_table / source_title_col à la valeur du catalogue. Défense en profondeur du correctif FOS-05.';
