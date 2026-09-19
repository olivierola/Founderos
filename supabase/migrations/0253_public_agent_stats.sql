-- ══════════════════════════════════════════════════════════════════════════
-- 0253 — Page publique de statistiques d'un agent public (opt-in)
-- ══════════════════════════════════════════════════════════════════════════
--
-- Un client peut rendre publiques les performances de son agent : une page
-- /stats/<public_key> montre combien de conversations il tient, combien il en
-- résout, en combien de temps il répond et comment il est noté. C'est une
-- preuve sociale pour le client ET une vitrine pour le produit.
--
-- Deux règles, tenues ici plutôt que dans le front :
--   1. OPT-IN. Rien n'est rendu tant que widget_config.public_stats n'est pas
--      explicitement vrai — ce sont les chiffres d'un client, pas les nôtres.
--   2. AGRÉGATS SEULEMENT. Aucune conversation, aucun visiteur, aucun pays,
--      aucune page : des totaux et une série quotidienne, rien qui permette de
--      remonter à une personne.
--
-- Pas de fonction edge (le projet est au plafond de 100) : une RPC security
-- definer, exécutable par `anon`, qui fait elle-même le contrôle d'opt-in.

create or replace function public.public_agent_stats(
  p_public_key text,
  p_days       int default 30
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_agent public.rag_agents;
  v_days  int := greatest(7, least(coalesce(p_days, 30), 90));
  v_since timestamptz;
  v_out   jsonb;
begin
  if p_public_key is null or length(p_public_key) < 6 then
    return jsonb_build_object('enabled', false);
  end if;

  select * into v_agent from public.rag_agents where public_key = p_public_key;
  -- Même réponse pour « inconnu » et « non publié » : la page ne doit pas
  -- servir à tester l'existence d'une clé.
  if not found
     or coalesce((v_agent.widget_config ->> 'public_stats')::boolean, false) is not true then
    return jsonb_build_object('enabled', false);
  end if;

  v_since := now() - make_interval(days => v_days);

  with conv as (
    select outcome, rating, first_response_ms, message_count, created_at
      from public.rag_conversations
     where agent_id = v_agent.id and created_at >= v_since
       and (message_count > 0 or outcome is not null)
  ),
  base as (
    select
      count(*)::int                                             as conversations,
      count(*) filter (where outcome = 'resolved')::int          as resolved,
      count(*) filter (where outcome = 'escalated')::int         as escalated,
      count(*) filter (where outcome is not null)::int           as with_outcome,
      count(*) filter (where rating is not null)::int            as rated,
      round(avg(rating) filter (where rating is not null)::numeric, 2) as avg_rating,
      round(percentile_cont(0.5) within group (order by first_response_ms)
            filter (where first_response_ms is not null))::int as median_first_ms,
      coalesce(sum(message_count), 0)::int                       as messages
    from conv
  ),
  daily as (
    select d::date as day,
           count(c.created_at)::int                               as conversations,
           count(c.created_at) filter (where c.outcome = 'resolved')::int as resolved
      from generate_series(date_trunc('day', v_since), date_trunc('day', now()), interval '1 day') d
      left join conv c on date_trunc('day', c.created_at) = d
     group by d order by d
  )
  select jsonb_build_object(
    'enabled', true,
    'agent', jsonb_build_object(
      'name', v_agent.name,
      'description', v_agent.description,
      'accent_color', coalesce(nullif(v_agent.widget_config ->> 'accent', ''), v_agent.accent_color)),
    'days', v_days,
    'totals', (select to_jsonb(base) from base),
    'all_time_conversations', (
      select count(*)::int from public.rag_conversations
       where agent_id = v_agent.id and (message_count > 0 or outcome is not null)),
    'daily', coalesce((select jsonb_agg(to_jsonb(daily) order by day) from daily), '[]'::jsonb),
    'generated_at', now()
  ) into v_out;

  return v_out;
end;
$$;

revoke all on function public.public_agent_stats(text, int) from public;
grant execute on function public.public_agent_stats(text, int) to anon, authenticated;
