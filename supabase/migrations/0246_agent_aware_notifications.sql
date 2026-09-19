-- 0246_agent_aware_notifications.sql
-- Les notifications disent quand c'est un agent qui parle.
--
-- Un agent qui termine ou qui bloque rend compte par un commentaire sur son work
-- item (voir le prompt de mission d'internal-agent-run). Ce commentaire
-- notifiait les abonnés comme n'importe quel autre : « Nouveau commentaire sur
-- X ». Or c'est LA notification qui compte dans le travail partagé avec des
-- agents — celle qui dit qu'une machine a produit quelque chose à vérifier — et
-- elle se noyait parmi les échanges ordinaires.
--
-- La fonction est reprise telle quelle depuis 0222 ; seule la branche des
-- commentaires change.

create or replace function public.pj_notify_on_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  issue_name text;
begin
  if tg_table_name = 'pj_issue_comments' then
    select name into issue_name from public.pj_issues where id = new.issue_id;
    -- Le titre NOMME l'agent quand c'en est un. « Nouveau commentaire sur X »
    -- ne dit pas si c'est un collègue qui pose une question ou une machine qui
    -- rend son travail — et ces deux notifications n'appellent pas le même
    -- geste : on répond à l'une, on VÉRIFIE l'autre.
    perform pj_notify_subscribers(new.issue_id, coalesce(new.actor_id, actor), 'commented',
      case
        when new.agent_id is not null then
          coalesce(new.agent_name, 'Un agent') || ' a répondu sur ' || coalesce(issue_name, 'un work item')
        else
          'Nouveau commentaire sur ' || coalesce(issue_name, 'un work item')
      end,
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
