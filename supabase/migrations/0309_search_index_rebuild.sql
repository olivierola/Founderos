-- 0309 : reconstruire l'index de recherche des agents (0308) d'un seul appel.
--
-- Les triggers de 0308 tiennent l'index à jour au fil de l'eau. Mais une copie
-- en masse qui les coupe (l'import d'une base Supabase vers la plateforme
-- auto-hébergée passe par session_replication_role = replica) laisse l'index
-- vide ou en retard : l'import appelle cette fonction à la fin, et
-- `npm run platform -- reindex` la lance à la demande.

create or replace function public.search_index_rebuild() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.search_index;
  perform public.search_sync_rag_chunk(id) from public.rag_chunks;
  perform public.search_sync_memory(id) from public.internal_agent_memories;
  perform public.search_sync_team_memory(id) from public.internal_agent_team_memories;
  perform public.search_sync_entity(id) from public.knowledge_entities;
  perform public.search_sync_fact(id) from public.knowledge_facts;
  perform public.search_sync_deliverable(id) from public.internal_agent_deliverables;
  perform public.search_sync_office_document(id) from public.office_documents;
  perform public.search_sync_message(id) from public.internal_agent_messages;
  select count(*)::int into n from public.search_index;
  return n;
end $$;

revoke all on function public.search_index_rebuild() from public, anon, authenticated;
