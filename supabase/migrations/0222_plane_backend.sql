-- 0222_plane_backend.sql
-- L'équivalent Supabase du backend Django de Plane.
--
-- 0221 a porté les TABLES. Ce que le serveur Django faisait en plus du CRUD —
-- journaliser chaque changement, notifier les abonnés, agréger, appeler des
-- webhooks, archiver ce qui traîne — vit ici, dans Postgres.
--
-- Pourquoi en base et pas dans une fonction edge : le projet est à 100
-- fonctions déployées, soit le plafond du plan. Mais c'est aussi le bon endroit
-- indépendamment de cette contrainte, pour une raison qui tenait déjà chez
-- Plane : le journal d'activité n'a de valeur QUE s'il est exhaustif. Tant
-- qu'il est écrit par l'appelant, il manque la ligne que le client a oublié
-- d'émettre, celle qu'un script d'import n'émet pas, et celle qu'un onglet a
-- perdue en se fermant. Un trigger, lui, voit tout ce qui touche la table.
--
-- Trois mécanismes reviennent partout :
--   · trigger     — ce qui doit être vrai à chaque écriture, sans exception
--   · fonction    — ce que le client appellerait sinon en dix requêtes
--   · outbox+cron — ce qui sort du système (webhooks), pour qu'un endpoint
--                   lent ou mort ne fasse jamais échouer l'écriture qui l'a
--                   déclenché

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Journal d'activité, écrit par la base
-- ────────────────────────────────────────────────────────────────────────────
-- `pj_issue_activity` existe depuis 0221 mais était alimentée par le client.
-- On la remplit désormais ici, et on ajoute de quoi savoir QUI a écrit : les
-- triggers lisent auth.uid(), qui vaut null pour un travail de fond.
alter table public.pj_issue_activity
  add column if not exists source text not null default 'app'
    check (source in ('app', 'trigger', 'automation', 'import'));

comment on column public.pj_issue_activity.source is
  'Qui a produit la ligne. Les entrées trigger sont les seules exhaustives ; les autres racontent un contexte que la base ne peut pas connaître.';

/**
 * Rend un identifiant lisible pour le journal. Sans ça, une ligne d'activité
 * dit « state_id: 3f2a… → 91b4… », ce qui n'apprend rien à personne.
 */
create or replace function public.pj_label_for(kind text, id uuid)
returns text language plpgsql stable as $$
declare
  out_text text;
begin
  if id is null then return null; end if;
  case kind
    when 'state' then select name into out_text from public.pj_states where pj_states.id = pj_label_for.id;
    when 'label' then select name into out_text from public.pj_labels where pj_labels.id = pj_label_for.id;
    when 'cycle' then select name into out_text from public.pj_cycles where pj_cycles.id = pj_label_for.id;
    when 'module' then select name into out_text from public.pj_modules where pj_modules.id = pj_label_for.id;
    when 'issue' then select name into out_text from public.pj_issues where pj_issues.id = pj_label_for.id;
    when 'user' then select coalesce(full_name, email) into out_text from public.profiles where profiles.id = pj_label_for.id;
    else out_text := id::text;
  end case;
  return coalesce(out_text, id::text);
end $$;

/**
 * Le journal des colonnes d'un work item.
 *
 * On énumère les champs un par un plutôt que de comparer les lignes en jsonb :
 * c'est plus long à écrire, mais c'est ce qui permet de nommer le champ dans la
 * langue du produit et de traduire les identifiants en noms. Un diff générique
 * produirait un journal techniquement complet et humainement illisible.
 */
create or replace function public.pj_journal_issue()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    insert into public.pj_issue_activity
      (issue_id, pj_project_id, workspace_id, actor_id, verb, comment, source)
    values (new.id, new.pj_project_id, new.workspace_id, actor, 'created',
            'a créé le work item', 'trigger');
    return new;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.name is distinct from old.name then
    insert into public.pj_issue_activity
      (issue_id, pj_project_id, workspace_id, actor_id, field, old_value, new_value, comment, source)
    values (new.id, new.pj_project_id, new.workspace_id, actor, 'name', old.name, new.name,
            'a renommé le work item', 'trigger');
  end if;

  if new.state_id is distinct from old.state_id then
    insert into public.pj_issue_activity
      (issue_id, pj_project_id, workspace_id, actor_id, field, old_value, new_value,
       old_identifier, new_identifier, comment, source)
    values (new.id, new.pj_project_id, new.workspace_id, actor, 'state',
            pj_label_for('state', old.state_id), pj_label_for('state', new.state_id),
            old.state_id, new.state_id, 'a changé l''état', 'trigger');
  end if;

  if new.priority is distinct from old.priority then
    insert into public.pj_issue_activity
      (issue_id, pj_project_id, workspace_id, actor_id, field, old_value, new_value, comment, source)
    values (new.id, new.pj_project_id, new.workspace_id, actor, 'priority', old.priority, new.priority,
            'a changé la priorité', 'trigger');
  end if;

  if new.target_date is distinct from old.target_date then
    insert into public.pj_issue_activity
      (issue_id, pj_project_id, workspace_id, actor_id, field, old_value, new_value, comment, source)
    values (new.id, new.pj_project_id, new.workspace_id, actor, 'target_date',
            old.target_date::text, new.target_date::text, 'a changé l''échéance', 'trigger');
  end if;

  if new.start_date is distinct from old.start_date then
    insert into public.pj_issue_activity
      (issue_id, pj_project_id, workspace_id, actor_id, field, old_value, new_value, comment, source)
    values (new.id, new.pj_project_id, new.workspace_id, actor, 'start_date',
            old.start_date::text, new.start_date::text, 'a changé la date de début', 'trigger');
  end if;

  if new.parent_id is distinct from old.parent_id then
    insert into public.pj_issue_activity
      (issue_id, pj_project_id, workspace_id, actor_id, field, old_value, new_value,
       old_identifier, new_identifier, comment, source)
    values (new.id, new.pj_project_id, new.workspace_id, actor, 'parent',
            pj_label_for('issue', old.parent_id), pj_label_for('issue', new.parent_id),
            old.parent_id, new.parent_id, 'a changé le parent', 'trigger');
  end if;

  -- La description change souvent et sa valeur est trop longue pour un journal.
  -- On note le fait, pas le contenu : personne ne relit un diff HTML dans une
  -- liste d'activité.
  if new.description_text is distinct from old.description_text then
    insert into public.pj_issue_activity
      (issue_id, pj_project_id, workspace_id, actor_id, field, comment, source)
    values (new.id, new.pj_project_id, new.workspace_id, actor, 'description',
            'a modifié la description', 'trigger');
  end if;

  if new.archived_at is distinct from old.archived_at then
    insert into public.pj_issue_activity
      (issue_id, pj_project_id, workspace_id, actor_id, field, comment, source)
    values (new.id, new.pj_project_id, new.workspace_id, actor, 'archived_at',
            case when new.archived_at is null then 'a désarchivé le work item'
                 else 'a archivé le work item' end, 'trigger');
  end if;

  return new;
end $$;

drop trigger if exists trg_pj_issues_journal on public.pj_issues;
create trigger trg_pj_issues_journal after insert or update on public.pj_issues
  for each row execute function public.pj_journal_issue();

/** Les liaisons n-n sont réécrites en bloc par le client (delete + insert), ce
 *  qui produirait un journal en dents de scie. On ne note donc que ce qui reste
 *  vrai : l'ajout et le retrait effectifs. */
create or replace function public.pj_journal_link()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  row_data record;
  kind text;
  verb_text text;
begin
  row_data := coalesce(new, old);
  kind := case tg_table_name
            when 'pj_issue_assignees' then 'user'
            when 'pj_issue_labels' then 'label'
            when 'pj_cycle_issues' then 'cycle'
            when 'pj_module_issues' then 'module'
          end;

  verb_text := case when tg_op = 'INSERT' then 'a ajouté' else 'a retiré' end;

  insert into public.pj_issue_activity
    (issue_id, pj_project_id, workspace_id, actor_id, field, new_value, comment, source)
  select
    row_data.issue_id,
    i.pj_project_id,
    i.workspace_id,
    actor,
    kind,
    pj_label_for(kind, case kind
      when 'user' then (to_jsonb(row_data) ->> 'user_id')::uuid
      when 'label' then (to_jsonb(row_data) ->> 'label_id')::uuid
      when 'cycle' then (to_jsonb(row_data) ->> 'cycle_id')::uuid
      when 'module' then (to_jsonb(row_data) ->> 'module_id')::uuid
    end),
    verb_text || ' ' || kind,
    'trigger'
  from public.pj_issues i
  where i.id = row_data.issue_id;

  return row_data;
end $$;

drop trigger if exists trg_pj_assignees_journal on public.pj_issue_assignees;
create trigger trg_pj_assignees_journal after insert or delete on public.pj_issue_assignees
  for each row execute function public.pj_journal_link();

drop trigger if exists trg_pj_labels_journal on public.pj_issue_labels;
create trigger trg_pj_labels_journal after insert or delete on public.pj_issue_labels
  for each row execute function public.pj_journal_link();

drop trigger if exists trg_pj_cycle_issues_journal on public.pj_cycle_issues;
create trigger trg_pj_cycle_issues_journal after insert or delete on public.pj_cycle_issues
  for each row execute function public.pj_journal_link();

drop trigger if exists trg_pj_module_issues_journal on public.pj_module_issues;
create trigger trg_pj_module_issues_journal after insert or delete on public.pj_module_issues
  for each row execute function public.pj_journal_link();

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Abonnements et notifications
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.pj_notifications (
  id            bigserial primary key,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  issue_id      uuid not null references public.pj_issues(id) on delete cascade,
  -- Le destinataire. Une notification par personne et par évènement : une ligne
  -- partagée obligerait à stocker qui l'a lue dans une table de plus.
  user_id       uuid not null references auth.users(id) on delete cascade,
  actor_id      uuid references auth.users(id) on delete set null,
  kind          text not null check (kind in ('assigned','mentioned','commented','state','subscribed')),
  title         text not null,
  body          text not null default '',
  read_at       timestamptz,
  archived_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_pj_notifications_inbox
  on public.pj_notifications(user_id, read_at, created_at desc);

/**
 * S'abonner automatiquement à ce qu'on touche.
 *
 * Chez Plane, on suit un item dès qu'on le crée, qu'on s'y fait assigner ou
 * qu'on y commente. Sans cet automatisme, l'abonnement est une case que
 * personne ne coche, et les notifications ne partent jamais.
 */
create or replace function public.pj_autosubscribe()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target_issue uuid;
  target_user uuid;
  ws uuid;
begin
  if tg_table_name = 'pj_issues' then
    target_issue := new.id; target_user := new.created_by; ws := new.workspace_id;
  elsif tg_table_name = 'pj_issue_assignees' then
    target_issue := new.issue_id; target_user := new.user_id; ws := new.workspace_id;
  else -- pj_issue_comments
    target_issue := new.issue_id; target_user := new.actor_id; ws := new.workspace_id;
  end if;

  if target_user is null then return new; end if;

  insert into public.pj_issue_subscribers (issue_id, workspace_id, user_id)
  values (target_issue, ws, target_user)
  on conflict (issue_id, user_id) do nothing;

  return new;
end $$;

drop trigger if exists trg_pj_issues_subscribe on public.pj_issues;
create trigger trg_pj_issues_subscribe after insert on public.pj_issues
  for each row execute function public.pj_autosubscribe();

drop trigger if exists trg_pj_assignees_subscribe on public.pj_issue_assignees;
create trigger trg_pj_assignees_subscribe after insert on public.pj_issue_assignees
  for each row execute function public.pj_autosubscribe();

drop trigger if exists trg_pj_comments_subscribe on public.pj_issue_comments;
create trigger trg_pj_comments_subscribe after insert on public.pj_issue_comments
  for each row execute function public.pj_autosubscribe();

/**
 * Diffuse un évènement aux abonnés, SAUF à son auteur : recevoir la
 * notification de sa propre action est la première raison pour laquelle les
 * gens coupent les notifications d'un outil.
 */
create or replace function public.pj_notify_subscribers(
  p_issue uuid, p_actor uuid, p_kind text, p_title text, p_body text default ''
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.pj_notifications (workspace_id, issue_id, user_id, actor_id, kind, title, body)
  select s.workspace_id, s.issue_id, s.user_id, p_actor, p_kind, p_title, p_body
  from public.pj_issue_subscribers s
  where s.issue_id = p_issue
    and (p_actor is null or s.user_id <> p_actor);
end $$;

create or replace function public.pj_notify_on_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  issue_name text;
begin
  if tg_table_name = 'pj_issue_comments' then
    select name into issue_name from public.pj_issues where id = new.issue_id;
    perform pj_notify_subscribers(new.issue_id, coalesce(new.actor_id, actor), 'commented',
                                  'Nouveau commentaire sur ' || coalesce(issue_name, 'un work item'),
                                  left(new.comment_html, 280));
    return new;
  end if;

  if tg_table_name = 'pj_issue_assignees' then
    select name into issue_name from public.pj_issues where id = new.issue_id;
    -- L'assigné est notifié même si c'est lui qui s'est assigné : l'exclusion
    -- ci-dessus vise le bruit de l'abonnement, pas l'accusé de prise en charge.
    insert into public.pj_notifications (workspace_id, issue_id, user_id, actor_id, kind, title)
    values (new.workspace_id, new.issue_id, new.user_id, actor, 'assigned',
            'Vous êtes assigné à ' || coalesce(issue_name, 'un work item'))
    on conflict do nothing;
    return new;
  end if;

  -- pj_issues : seul le changement d'état vaut une notification. Notifier
  -- chaque frappe dans la description viderait la boîte de réception de son
  -- sens.
  if new.state_id is distinct from old.state_id then
    perform pj_notify_subscribers(new.id, actor, 'state',
      coalesce(new.name, 'Work item') || ' → ' || coalesce(pj_label_for('state', new.state_id), 'sans état'));
  end if;
  return new;
end $$;

drop trigger if exists trg_pj_issues_notify on public.pj_issues;
create trigger trg_pj_issues_notify after update of state_id on public.pj_issues
  for each row execute function public.pj_notify_on_change();

drop trigger if exists trg_pj_comments_notify on public.pj_issue_comments;
create trigger trg_pj_comments_notify after insert on public.pj_issue_comments
  for each row execute function public.pj_notify_on_change();

drop trigger if exists trg_pj_assignees_notify on public.pj_issue_assignees;
create trigger trg_pj_assignees_notify after insert on public.pj_issue_assignees
  for each row execute function public.pj_notify_on_change();

alter table public.pj_notifications enable row level security;
drop policy if exists "own notifications" on public.pj_notifications;
create policy "own notifications" on public.pj_notifications for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Agrégats : ce que le client calculerait en tirant tout le projet
-- ────────────────────────────────────────────────────────────────────────────
/**
 * L'avancement d'un périmètre (projet, cycle ou module) en une requête.
 *
 * Le client sait le calculer — il le fait déjà pour les cartes — mais seulement
 * parce qu'il a DÉJÀ tous les items en mémoire. Dès qu'un projet dépasse
 * quelques milliers d'items, les tirer pour n'en compter que cinq nombres
 * devient absurde ; c'est le seul cas où l'agrégat doit descendre en base.
 */
create or replace function public.pj_progress(
  p_project uuid, p_cycle uuid default null, p_module uuid default null
) returns table (
  total bigint, backlog bigint, unstarted bigint, started bigint,
  completed bigint, cancelled bigint, overdue bigint
) language sql stable security invoker as $$
  with scoped as (
    select i.id, i.target_date, i.completed_at, s."group" as grp
    from public.pj_issues i
    left join public.pj_states s on s.id = i.state_id
    where i.pj_project_id = p_project
      and i.archived_at is null
      and i.is_draft = false
      and (p_cycle is null or exists (
            select 1 from public.pj_cycle_issues ci where ci.issue_id = i.id and ci.cycle_id = p_cycle))
      and (p_module is null or exists (
            select 1 from public.pj_module_issues mi where mi.issue_id = i.id and mi.module_id = p_module))
  )
  select
    count(*),
    count(*) filter (where grp = 'backlog'),
    count(*) filter (where grp = 'unstarted'),
    count(*) filter (where grp = 'started'),
    count(*) filter (where grp = 'completed'),
    count(*) filter (where grp = 'cancelled'),
    count(*) filter (where target_date < current_date and completed_at is null)
  from scoped;
$$;

/**
 * Le burndown d'un cycle : combien d'items restaient ouverts chaque jour.
 *
 * On le reconstruit depuis `completed_at` plutôt que de stocker un compteur
 * quotidien : un compteur suppose qu'un travail de fond tourne tous les jours
 * sans jamais rater une exécution, et une seule journée manquante laisse un
 * trou définitif dans la courbe.
 */
create or replace function public.pj_burndown(p_cycle uuid)
returns table (day date, remaining bigint, completed bigint) language sql stable as $$
  with cycle as (select start_date, end_date from public.pj_cycles where id = p_cycle),
  days as (
    select generate_series(c.start_date, least(c.end_date, current_date), interval '1 day')::date as day
    from cycle c where c.start_date is not null and c.end_date is not null
  ),
  scoped as (
    select i.completed_at
    from public.pj_cycle_issues ci
    join public.pj_issues i on i.id = ci.issue_id
    where ci.cycle_id = p_cycle and i.archived_at is null
  )
  select
    d.day,
    (select count(*) from scoped s
      where s.completed_at is null or s.completed_at::date > d.day),
    (select count(*) from scoped s
      where s.completed_at is not null and s.completed_at::date <= d.day)
  from days d
  order by d.day;
$$;

/**
 * La recherche transverse d'un dashboard : work items, cycles, modules, pages.
 *
 * Une seule fonction plutôt que quatre requêtes côté client, parce que le
 * classement doit être GLOBAL : quatre listes triées chacune de son côté
 * remonteraient un cycle vaguement pertinent au-dessus du work item qu'on
 * cherchait.
 */
create or replace function public.pj_search(p_dashboard uuid, p_query text, p_limit int default 20)
returns table (kind text, id uuid, pj_project_id uuid, title text, subtitle text, rank real)
language sql stable as $$
  with q as (select websearch_to_tsquery('simple', p_query) as ts, p_query as raw)
  select * from (
    select 'issue'::text, i.id, i.pj_project_id, i.name,
           p.identifier || '-' || i.sequence_id,
           ts_rank(to_tsvector('simple', i.name || ' ' || i.description_text), q.ts)
    from public.pj_issues i
    join public.pj_projects p on p.id = i.pj_project_id
    cross join q
    where p.dashboard_id = p_dashboard and i.archived_at is null
      and to_tsvector('simple', i.name || ' ' || i.description_text) @@ q.ts

    union all
    select 'cycle', c.id, c.pj_project_id, c.name, p.name, 0.5::real
    from public.pj_cycles c join public.pj_projects p on p.id = c.pj_project_id
    cross join q
    where p.dashboard_id = p_dashboard and c.name ilike '%' || q.raw || '%'

    union all
    select 'module', m.id, m.pj_project_id, m.name, p.name, 0.5::real
    from public.pj_modules m join public.pj_projects p on p.id = m.pj_project_id
    cross join q
    where p.dashboard_id = p_dashboard and m.name ilike '%' || q.raw || '%'

    union all
    select 'page', pg.id, pg.pj_project_id, pg.name, p.name, 0.4::real
    from public.pj_pages pg join public.pj_projects p on p.id = pg.pj_project_id
    cross join q
    where p.dashboard_id = p_dashboard and pg.archived_at is null
      and pg.name ilike '%' || q.raw || '%'
  ) results(kind, id, pj_project_id, title, subtitle, rank)
  order by rank desc, title
  limit p_limit;
$$;

/**
 * Modification en lot. Le client l'appellerait sinon en N écritures, ce qui
 * donne une sélection de cinquante items dont la moitié bascule et l'autre pas
 * si le réseau lâche au milieu.
 */
create or replace function public.pj_bulk_update(
  p_issues uuid[], p_state uuid default null, p_priority text default null,
  p_cycle uuid default null, p_target_date date default null
) returns int language plpgsql security invoker as $$
declare
  touched int;
begin
  update public.pj_issues
     set state_id    = coalesce(p_state, state_id),
         priority    = coalesce(p_priority, priority),
         target_date = coalesce(p_target_date, target_date),
         updated_at  = now(),
         updated_by  = auth.uid()
   where id = any(p_issues);
  get diagnostics touched = row_count;

  if p_cycle is not null then
    delete from public.pj_cycle_issues where issue_id = any(p_issues);
    insert into public.pj_cycle_issues (cycle_id, issue_id, workspace_id)
    select p_cycle, i.id, i.workspace_id from public.pj_issues i where i.id = any(p_issues);
  end if;

  return touched;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Webhooks : la sortie du système
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.pj_webhooks (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  dashboard_id  uuid references public.service_dashboards(id) on delete cascade,
  url           text not null,
  -- pgcrypto vit dans le schéma `extensions` sur Supabase, et il n'est pas dans
  -- le search_path des migrations : sans le préfixe, la création de la table
  -- échoue sur « function gen_random_bytes does not exist ».
  secret        text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  events        text[] not null default array['issue.created','issue.updated'],
  is_active     boolean not null default true,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);

-- L'outbox. Le trigger écrit ICI et rend la main : un endpoint client lent ou
-- injoignable ne doit jamais retenir — ni faire échouer — la transaction qui a
-- créé le work item.
create table if not exists public.pj_webhook_deliveries (
  id            bigserial primary key,
  webhook_id    uuid not null references public.pj_webhooks(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  event         text not null,
  payload       jsonb not null,
  status        text not null default 'pending'
                check (status in ('pending','sent','failed')),
  attempts      int not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);
create index if not exists idx_pj_webhook_pending
  on public.pj_webhook_deliveries(status, created_at) where status = 'pending';

create or replace function public.pj_enqueue_webhook()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  row_data record := coalesce(new, old);
  event_name text;
  dash uuid;
begin
  event_name := replace(tg_table_name, 'pj_', '') || '.' || lower(tg_op);

  select p.dashboard_id into dash from public.pj_projects p where p.id = row_data.pj_project_id;

  insert into public.pj_webhook_deliveries (webhook_id, workspace_id, event, payload)
  select w.id, w.workspace_id, event_name, to_jsonb(row_data)
  from public.pj_webhooks w
  where w.is_active
    and w.workspace_id = row_data.workspace_id
    and (w.dashboard_id is null or w.dashboard_id = dash)
    and event_name = any(w.events);

  return row_data;
end $$;

drop trigger if exists trg_pj_issues_webhook on public.pj_issues;
create trigger trg_pj_issues_webhook after insert or update or delete on public.pj_issues
  for each row execute function public.pj_enqueue_webhook();

/**
 * Vide l'outbox. Appelée par cron, elle poste en HTTP via pg_net (asynchrone :
 * la fonction rend la main sans attendre la réponse).
 *
 * Trois tentatives puis abandon. Réessayer indéfiniment sur un endpoint mort
 * transforme la file en boucle qui consomme sans fin, et masque les livraisons
 * récentes derrière un fond d'échecs anciens.
 */
create or replace function public.pj_drain_webhooks()
returns int language plpgsql security definer set search_path = public as $$
declare
  d record;
  n int := 0;
begin
  for d in
    select dl.*, w.url, w.secret
    from public.pj_webhook_deliveries dl
    join public.pj_webhooks w on w.id = dl.webhook_id
    where dl.status = 'pending' and dl.attempts < 3
    order by dl.created_at
    limit 50
  loop
    perform net.http_post(
      url := d.url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Plane-Event', d.event,
        'X-Plane-Signature', encode(extensions.hmac(d.payload::text, d.secret, 'sha256'), 'hex')
      ),
      body := jsonb_build_object('event', d.event, 'data', d.payload)
    );
    update public.pj_webhook_deliveries
       set status = 'sent', attempts = attempts + 1, sent_at = now()
     where id = d.id;
    n := n + 1;
  end loop;

  -- Ce qui a épuisé ses tentatives sort de la file, sinon il la relit à chaque
  -- passage sans jamais partir.
  update public.pj_webhook_deliveries
     set status = 'failed', last_error = coalesce(last_error, 'trois tentatives épuisées')
   where status = 'pending' and attempts >= 3;

  return n;
end $$;

select cron.schedule('pj-drain-webhooks', '* * * * *', $$ select public.pj_drain_webhooks(); $$);

alter table public.pj_webhooks enable row level security;
alter table public.pj_webhook_deliveries enable row level security;

drop policy if exists "workspace members manage webhooks" on public.pj_webhooks;
create policy "workspace members manage webhooks" on public.pj_webhooks for all
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = pj_webhooks.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm
                       where wm.workspace_id = pj_webhooks.workspace_id and wm.user_id = auth.uid()));

-- Les livraisons se lisent (pour diagnostiquer) mais ne s'écrivent pas depuis
-- le client : une file d'envoi modifiable rendrait la signature sans valeur.
drop policy if exists "workspace members read deliveries" on public.pj_webhook_deliveries;
create policy "workspace members read deliveries" on public.pj_webhook_deliveries for select
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = pj_webhook_deliveries.workspace_id and wm.user_id = auth.uid()));

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Entretien automatique
-- ────────────────────────────────────────────────────────────────────────────
-- Les deux réglages de Plane : archiver ce qui est terminé depuis longtemps,
-- et clore ce qui dort dans le backlog. Ils sont désactivés par défaut — une
-- règle qui déplace des items sans qu'on l'ait demandée passe pour un bug.
alter table public.pj_projects
  add column if not exists archive_in int not null default 0 check (archive_in between 0 and 12),
  add column if not exists close_in int not null default 0 check (close_in between 0 and 12);

comment on column public.pj_projects.archive_in is
  'Mois après complétion au bout desquels un work item est archivé. 0 = jamais.';

create or replace function public.pj_run_maintenance()
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.pj_issues i
     set archived_at = now()
    from public.pj_projects p
   where p.id = i.pj_project_id
     and p.archive_in > 0
     and i.archived_at is null
     and i.completed_at is not null
     and i.completed_at < now() - (p.archive_in || ' months')::interval;

  -- Clore, c'est basculer vers l'état « annulé » du projet — pas inventer un
  -- statut parallèle que les boards ignoreraient.
  update public.pj_issues i
     set state_id = cancelled.id
    from public.pj_projects p
    join lateral (
      select s.id from public.pj_states s
      where s.pj_project_id = p.id and s."group" = 'cancelled'
      order by s.sequence limit 1
    ) cancelled on true
   where p.id = i.pj_project_id
     and p.close_in > 0
     and i.archived_at is null
     and i.completed_at is null
     and i.updated_at < now() - (p.close_in || ' months')::interval
     and exists (select 1 from public.pj_states s
                  where s.id = i.state_id and s."group" = 'backlog');
end $$;

-- Une fois par nuit : ces règles se comptent en mois, les repasser plus souvent
-- ne changerait rien d'autre que la charge.
select cron.schedule('pj-maintenance', '30 3 * * *', $$ select public.pj_run_maintenance(); $$);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Pièces jointes
-- ────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('pj-attachments', 'pj-attachments', true)
on conflict (id) do nothing;

drop policy if exists "pj-attachments upload" on storage.objects;
create policy "pj-attachments upload" on storage.objects for insert
  with check (bucket_id = 'pj-attachments' and auth.role() = 'authenticated');

drop policy if exists "pj-attachments select" on storage.objects;
create policy "pj-attachments select" on storage.objects for select
  using (bucket_id = 'pj-attachments');

drop policy if exists "pj-attachments delete" on storage.objects;
create policy "pj-attachments delete" on storage.objects for delete
  using (bucket_id = 'pj-attachments' and auth.role() = 'authenticated');

comment on function public.pj_progress is
  'Avancement d''un projet, cycle ou module en une requête — le seul agrégat qui doit descendre en base, quand le volume interdit de tout tirer côté client.';
comment on function public.pj_burndown is
  'Burndown reconstruit depuis completed_at : pas de compteur quotidien, donc pas de trou définitif si une exécution est ratée.';
