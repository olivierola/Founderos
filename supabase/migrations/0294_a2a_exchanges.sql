-- 0294 — Des échanges bornés entre agents : une idée soumise à un collègue,
-- un challenge, un débat.
--
-- Jusqu'ici un message A2A appelait une réponse, et c'était tout. Un échange
-- porte désormais :
--   · kind        — 'message' (comme avant), 'idea', 'challenge' ou 'debate' :
--                   la consigne donnée à l'agent qui répond en dépend ;
--   · turns_left  — combien de répliques il reste. Chaque réponse en consomme
--                   une ; à zéro, la dernière réplique naît « answered » et
--                   personne ne la relance (le balayage du planificateur ne
--                   prend que les messages « pending »). Null : pas de borne,
--                   le comportement d'avant ;
--   · started_by  — la personne qui a lancé l'échange depuis le Live Space,
--                   quand ce n'est pas un agent.
--
-- Les lectures restent celles de 0044 (les membres du workspace) ; l'écriture
-- passe toujours par la fonction internal-agent-a2a, en service role.

alter table public.internal_agent_a2a_messages
  add column if not exists kind text not null default 'message',
  add column if not exists turns_left int,
  add column if not exists started_by uuid references auth.users(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'internal_agent_a2a_messages_kind_check'
  ) then
    alter table public.internal_agent_a2a_messages
      add constraint internal_agent_a2a_messages_kind_check
      check (kind in ('message', 'idea', 'challenge', 'debate'));
  end if;
end $$;

-- Le Live Space lit les échanges récents d'un service : par projet, du plus
-- récent au plus ancien.
create index if not exists idx_a2a_messages_project_recent
  on public.internal_agent_a2a_messages(project_id, created_at desc);
