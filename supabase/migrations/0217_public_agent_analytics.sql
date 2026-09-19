-- 0217_public_agent_analytics.sql
--
-- (Renumérotée : ce fichier portait 0216, déjà pris par 0216_automations.sql.
--  Deux fichiers pour une même version = la seconde est considérée comme
--  appliquée et sautée en silence par `supabase db push` — c'est ainsi que la
--  fonction rag_agent_analytics n'a jamais atterri sur la base.)
-- Télémétrie des agents publics : de quoi alimenter les pages Performance et
-- Audience.
--
-- Jusqu'ici une conversation ne portait que (source, rating). On pouvait donc
-- compter des conversations, pas raconter ce qui s'y est passé : impossible de
-- dire si l'agent a résolu, s'il a été contourné, d'où venait le visiteur, ni
-- combien de temps il a attendu sa première réponse. Les colonnes ci-dessous
-- sont écrites par rag-chat au fil de la conversation (pas recalculées après
-- coup) : l'issue d'une conversation dépend de signaux que seule la fonction
-- voit passer (une réponse sans source, une demande d'humain, un outil en
-- échec), et les reconstruire depuis les messages serait une devinette.
--
-- ⚠️ L'historique antérieur reste NULL sur ces colonnes. Les vues les traitent
-- comme « inconnu » plutôt que de les compter à zéro : un taux de résolution ne
-- doit pas plonger parce qu'on vient d'installer le compteur.

-- ── Dimensions et issue d'une conversation ───────────────────────────────────
alter table public.rag_conversations
  -- Canal : 'widget' | 'playground' | 'api'. `source` existe déjà et porte la
  -- même chose ; on le garde tel quel et on ne dédouble pas.

  -- Provenance. Le pays vient de l'en-tête géo de l'edge (cf-ipcountry et
  -- consorts) et, à défaut, du fuseau horaire annoncé par le navigateur — une
  -- approximation assumée, jamais une géoloc IP fine.
  add column if not exists country      text,
  add column if not exists timezone     text,
  add column if not exists locale       text,
  add column if not exists device       text,   -- desktop | mobile | tablet
  add column if not exists referrer     text,   -- origine de la page hôte
  add column if not exists page_url     text,   -- page où le widget était posé

  -- Volumétrie tenue à jour à chaque tour, pour éviter de compter les messages
  -- de 10 000 conversations côté client à chaque affichage.
  add column if not exists message_count       int not null default 0,
  add column if not exists user_message_count  int not null default 0,
  -- Réponses appuyées sur au moins une source du corpus : c'est la définition
  -- de « l'agent avait de quoi répondre » retenue partout dans les pages stat.
  add column if not exists grounded_answers    int not null default 0,
  add column if not exists tool_call_count     int not null default 0,
  add column if not exists first_response_ms   int,
  add column if not exists last_message_at     timestamptz,

  -- Issue. 'resolved' | 'unresolved' | 'escalated' | 'abandoned'.
  --   resolved   : au moins une réponse sourcée, aucun signal contraire
  --   unresolved : une réponse sans aucune source, ou une note 1-2
  --   escalated  : le visiteur a demandé un humain
  --   abandoned  : posé une question, reparti sans réponse exploitable
  add column if not exists outcome        text,
  -- Motif lisible (answer_quality, no_knowledge, tool_failure, user_effort,
  -- policy, negative_rating, positive_rating…) : c'est lui qui remplit les
  -- barres « motifs CX » et il est posé là où le signal existe, pas déduit
  -- d'une classification a posteriori.
  add column if not exists outcome_reason text,
  add column if not exists escalated_at   timestamptz,
  add column if not exists rated_at       timestamptz;

alter table public.rag_conversations drop constraint if exists rag_conversations_outcome_check;
alter table public.rag_conversations add constraint rag_conversations_outcome_check
  check (outcome is null or outcome in ('resolved','unresolved','escalated','abandoned'));

alter table public.rag_conversations drop constraint if exists rag_conversations_device_check;
alter table public.rag_conversations add constraint rag_conversations_device_check
  check (device is null or device in ('desktop','mobile','tablet'));

-- Les pages stat filtrent toujours (agent, fenêtre de temps) puis regroupent ;
-- cet index couvre l'entrée de toutes les agrégations ci-dessous.
create index if not exists idx_rag_conversations_agent_created
  on public.rag_conversations(agent_id, created_at desc);
create index if not exists idx_rag_conversations_outcome
  on public.rag_conversations(agent_id, outcome) where outcome is not null;

-- ── Agrégation ───────────────────────────────────────────────────────────────
-- Une seule RPC rend tout ce que les pages affichent. Le client ne rapatrie
-- plus 2 000 lignes de conversations et 3 000 de messages pour les recompter
-- dans le navigateur (ce que faisait l'onglet Analytics) : au-delà de quelques
-- milliers de lignes ce plafond mentait silencieusement sur les totaux.
--
-- security definer + contrôle d'appartenance explicite : la fonction lit des
-- tables protégées par RLS, donc elle doit vérifier elle-même que l'appelant
-- est membre du workspace de l'agent.
create or replace function public.rag_agent_analytics(
  p_agent_id uuid,
  p_days     int default 30
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_agent      public.rag_agents;
  v_since      timestamptz;
  v_prev_since timestamptz;
  v_days       int := greatest(1, least(coalesce(p_days, 30), 365));
  v_out        jsonb;
begin
  select * into v_agent from public.rag_agents where id = p_agent_id;
  if not found then
    raise exception 'Agent introuvable';
  end if;
  if not exists (
    select 1 from public.workspace_members wm
     where wm.workspace_id = v_agent.workspace_id and wm.user_id = auth.uid()
  ) then
    raise exception 'Accès refusé';
  end if;

  v_since      := now() - make_interval(days => v_days);
  v_prev_since := now() - make_interval(days => v_days * 2);

  with conv as (
    select * from public.rag_conversations
     where agent_id = p_agent_id and created_at >= v_since
  ),
  prev as (
    select * from public.rag_conversations
     where agent_id = p_agent_id and created_at >= v_prev_since and created_at < v_since
  ),
  -- Une conversation « impliquant » l'agent est une conversation où il a
  -- effectivement répondu. Une session ouverte sans question ne compte pas
  -- dans le dénominateur du taux de résolution — sinon l'agent est puni pour
  -- des visiteurs qui n'ont rien demandé.
  base as (
    select
      count(*)::int                                                    as total,
      count(*) filter (where message_count > 0 or outcome is not null)::int as involved,
      count(*) filter (where outcome = 'resolved')::int                as resolved,
      count(*) filter (where outcome = 'unresolved')::int              as unresolved,
      count(*) filter (where outcome = 'escalated')::int               as escalated,
      count(*) filter (where outcome = 'abandoned')::int               as abandoned,
      count(*) filter (where outcome is null)::int                     as unknown_outcome,
      count(*) filter (where rating is not null)::int                  as rated,
      count(*) filter (where rating >= 4)::int                         as rated_positive,
      count(*) filter (where rating = 3)::int                          as rated_neutral,
      count(*) filter (where rating <= 2)::int                         as rated_negative,
      count(distinct visitor_id) filter (where visitor_id is not null)::int as visitors,
      -- « Rebond » : une seule question posée, jamais suivie. Le pendant
      -- conversationnel du bounce d'une page.
      count(*) filter (where user_message_count = 1)::int              as single_turn,
      coalesce(sum(message_count), 0)::int                             as messages,
      coalesce(sum(tool_call_count), 0)::int                           as tool_calls,
      avg(first_response_ms) filter (where first_response_ms is not null) as avg_first_ms,
      avg(extract(epoch from (last_message_at - created_at)))
        filter (where last_message_at is not null)                     as avg_duration_s,
      avg(rating) filter (where rating is not null)                    as avg_rating
    from conv
  ),
  prev_base as (
    select
      count(*)::int                                       as total,
      count(*) filter (where outcome = 'resolved')::int    as resolved,
      count(*) filter (where message_count > 0 or outcome is not null)::int as involved,
      count(*) filter (where rating is not null)::int      as rated,
      count(*) filter (where rating >= 4)::int             as rated_positive,
      count(distinct visitor_id) filter (where visitor_id is not null)::int as visitors
    from prev
  ),
  daily as (
    select d::date as day,
           count(c.id)::int                                        as conversations,
           count(distinct c.visitor_id)::int                       as visitors,
           coalesce(sum(c.message_count), 0)::int                  as messages,
           count(c.id) filter (where c.outcome = 'resolved')::int   as resolved
      from generate_series(date_trunc('day', v_since), date_trunc('day', now()), interval '1 day') d
      left join conv c on date_trunc('day', c.created_at) = d
     group by d order by d
  ),
  ratings as (
    select rating::int as score, count(*)::int as n
      from conv where rating is not null group by rating order by rating
  ),
  reasons_pos as (
    select coalesce(outcome_reason, 'unspecified') as reason, count(*)::int as n
      from conv where rating >= 4 group by 1 order by n desc limit 8
  ),
  reasons_neg as (
    select coalesce(outcome_reason, 'unspecified') as reason, count(*)::int as n
      from conv where rating <= 2 group by 1 order by n desc limit 8
  ),
  -- Les motifs d'échec ne dépendent pas d'une note : la plupart des visiteurs
  -- ne notent jamais. Ceux-là comptent les conversations non résolues.
  reasons_unres as (
    select coalesce(outcome_reason, 'unspecified') as reason, count(*)::int as n
      from conv where outcome in ('unresolved','escalated','abandoned') group by 1 order by n desc limit 8
  ),
  countries as (
    select country as code, count(*)::int as conversations,
           count(distinct visitor_id)::int as visitors
      from conv where country is not null group by country order by visitors desc, conversations desc limit 12
  ),
  devices as (
    select coalesce(device, 'unknown') as device, count(*)::int as n
      from conv group by 1 order by n desc
  ),
  channels as (
    select coalesce(source, 'widget') as channel, count(*)::int as n,
           count(*) filter (where outcome = 'resolved')::int as resolved,
           count(*) filter (where message_count > 0 or outcome is not null)::int as involved
      from conv group by 1 order by n desc
  ),
  -- Croisement issue × satisfaction : c'est le dernier étage de l'entonnoir.
  -- Sans ce tableau croisé, relier « résolue » à « CX positif » reviendrait à
  -- répartir au prorata, donc à dessiner un flux qui n'a jamais existé.
  outcome_cx as (
    select coalesce(outcome, 'unknown') as outcome,
           case when rating is null then 'unrated'
                when rating >= 4     then 'positive'
                when rating = 3      then 'neutral'
                else 'negative' end  as cx,
           count(*)::int as n
      from conv group by 1, 2
  ),
  referrers as (
    select referrer as referrer, count(*)::int as n
      from conv where referrer is not null and referrer <> '' group by 1 order by n desc limit 8
  ),
  pages as (
    select page_url as page, count(*)::int as n
      from conv where page_url is not null and page_url <> '' group by 1 order by n desc limit 8
  ),
  questions as (
    select left(m.content, 80) as question, count(*)::int as n
      from public.rag_messages m
     where m.agent_id = p_agent_id and m.role = 'user' and m.created_at >= v_since
     group by 1 order by n desc limit 10
  ),
  tools as (
    select t.tool_name, count(*)::int as calls,
           count(*) filter (where not t.ok)::int as errors,
           avg(t.duration_ms) as avg_ms
      from public.rag_agent_tool_calls t
     where t.agent_id = p_agent_id and t.created_at >= v_since
     group by t.tool_name order by calls desc limit 12
  ),
  llm as (
    select count(*)::int as requests,
           coalesce(sum(u.total_tokens), 0)::bigint as tokens,
           coalesce(sum(u.estimated_cost_cents), 0)::bigint as cost_cents
      from public.llm_usage u
     where u.project_id = v_agent.project_id and u.feature in ('rag-agent','rag-chat')
       and u.created_at >= v_since
  ),
  kb as (
    select count(*)::int as sources,
           count(*) filter (where status = 'ready')::int as ready,
           coalesce(sum(chunk_count), 0)::int as chunks
      from public.rag_sources where agent_id = p_agent_id
  )
  select jsonb_build_object(
    'days',        v_days,
    'since',       v_since,
    'totals',      to_jsonb(base.*),
    'previous',    to_jsonb(prev_base.*),
    'daily',       coalesce((select jsonb_agg(to_jsonb(daily.*)) from daily), '[]'::jsonb),
    'ratings',     coalesce((select jsonb_agg(to_jsonb(ratings.*)) from ratings), '[]'::jsonb),
    'reasons_positive',  coalesce((select jsonb_agg(to_jsonb(reasons_pos.*)) from reasons_pos), '[]'::jsonb),
    'reasons_negative',  coalesce((select jsonb_agg(to_jsonb(reasons_neg.*)) from reasons_neg), '[]'::jsonb),
    'reasons_unresolved',coalesce((select jsonb_agg(to_jsonb(reasons_unres.*)) from reasons_unres), '[]'::jsonb),
    'countries',   coalesce((select jsonb_agg(to_jsonb(countries.*)) from countries), '[]'::jsonb),
    'devices',     coalesce((select jsonb_agg(to_jsonb(devices.*)) from devices), '[]'::jsonb),
    'channels',    coalesce((select jsonb_agg(to_jsonb(channels.*)) from channels), '[]'::jsonb),
    'outcome_cx',  coalesce((select jsonb_agg(to_jsonb(outcome_cx.*)) from outcome_cx), '[]'::jsonb),
    'referrers',   coalesce((select jsonb_agg(to_jsonb(referrers.*)) from referrers), '[]'::jsonb),
    'pages',       coalesce((select jsonb_agg(to_jsonb(pages.*)) from pages), '[]'::jsonb),
    'questions',   coalesce((select jsonb_agg(to_jsonb(questions.*)) from questions), '[]'::jsonb),
    'tools',       coalesce((select jsonb_agg(to_jsonb(tools.*)) from tools), '[]'::jsonb),
    'llm',         (select to_jsonb(llm.*) from llm),
    'knowledge',   (select to_jsonb(kb.*) from kb)
  ) into v_out
  from base, prev_base;

  return v_out;
end $$;

revoke all on function public.rag_agent_analytics(uuid, int) from public;
grant execute on function public.rag_agent_analytics(uuid, int) to authenticated;

-- ── Écriture d'un tour de conversation ───────────────────────────────────────
-- Les compteurs sont incrémentés en base plutôt que lus-modifiés-réécrits par
-- l'edge : deux onglets ouverts sur la même conversation écraseraient sinon
-- leurs compteurs mutuels. Appelée par rag-chat avec la clé de service.
--
-- Règle d'issue : le dernier tour décide, SAUF l'escalade qui est collante —
-- une conversation partie chez un humain reste une conversation escaladée même
-- si l'agent répond encore une fois derrière.
create or replace function public.rag_conversation_record_turn(
  p_conversation      uuid,
  p_grounded          boolean default false,
  p_tool_calls        int     default 0,
  p_first_response_ms int     default null,
  p_outcome           text    default null,
  p_outcome_reason    text    default null
) returns void
language sql volatile security definer set search_path = public as $$
  update public.rag_conversations set
    message_count      = message_count + 2,
    user_message_count = user_message_count + 1,
    grounded_answers   = grounded_answers + (case when p_grounded then 1 else 0 end),
    tool_call_count    = tool_call_count + coalesce(p_tool_calls, 0),
    first_response_ms  = coalesce(first_response_ms, p_first_response_ms),
    last_message_at    = now(),
    outcome            = case when outcome = 'escalated' then 'escalated'
                              else coalesce(p_outcome, outcome) end,
    outcome_reason     = case when outcome = 'escalated' then outcome_reason
                              else coalesce(p_outcome_reason, outcome_reason) end,
    escalated_at       = case when p_outcome = 'escalated' then coalesce(escalated_at, now())
                              else escalated_at end
  where id = p_conversation;
$$;

revoke all on function public.rag_conversation_record_turn(uuid, boolean, int, int, text, text) from public;
grant execute on function public.rag_conversation_record_turn(uuid, boolean, int, int, text, text) to service_role;
