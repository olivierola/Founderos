-- 0305 — Le harnais aligné sur OpenCode : sous-agents en arrière-plan, réponse
-- en flux visible pendant le run.
--
-- 1. internal_agent_run_inbox : la boîte de réception d'un run. Un sous-agent
--    lancé en arrière-plan y dépose son résultat (kind = background_result),
--    son parent y lit au tick suivant un message <background-result>. Le
--    parent peut aussi y déposer une relance pour un enfant en cours
--    (kind = follow_up). Écrite et lue par le runtime seulement (service).
--
-- 2. agent_run_wake(run_id) : réveille un run EN ATTENTE de ses sous-agents
--    (meta.awaiting_children), et seulement lui, en un seul geste : l'état est
--    marqué réveillé et un tick mis en file dans la même transaction. Un run
--    qui n'attendait pas n'est pas touché, ce qui garantit qu'il n'a jamais
--    deux ticks en vol (la file ne déduplique pas).
--
-- 3. internal_agent_runs.live_output : le texte que le modèle est en train
--    d'écrire, mis à jour pendant le flux (toutes les ~700 ms au plus) et
--    vidé à la fin du tour. La timeline le lit par le même abonnement temps
--    réel que le reste du run, donc sous les mêmes droits (RLS).

create table if not exists public.internal_agent_run_inbox (
  id uuid primary key default gen_random_uuid(),
  -- Le destinataire : le parent (résultat d'un enfant) ou l'enfant (relance).
  run_id uuid not null references public.internal_agent_runs(id) on delete cascade,
  from_run_id uuid references public.internal_agent_runs(id) on delete set null,
  kind text not null default 'background_result' check (kind in ('background_result', 'follow_up')),
  label text,
  status text,
  content text not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

create index if not exists internal_agent_run_inbox_pending_idx
  on public.internal_agent_run_inbox (run_id, created_at) where consumed_at is null;
create index if not exists internal_agent_run_inbox_from_idx
  on public.internal_agent_run_inbox (from_run_id);

alter table public.internal_agent_run_inbox enable row level security;
-- Aucune politique : seul le rôle de service (le runtime) lit et écrit.
revoke all on public.internal_agent_run_inbox from anon, authenticated;
grant all on public.internal_agent_run_inbox to service_role;

create or replace function public.agent_run_wake(p_run_id uuid)
  returns boolean language plpgsql security definer set search_path = public, pgmq as
$$
declare parked boolean := false;
begin
  update public.internal_agent_run_state
     set meta = (coalesce(meta, '{}'::jsonb) - 'awaiting_children') || jsonb_build_object('woken_at', now()),
         processing_until = null,
         updated_at = now()
   where run_id = p_run_id
     and coalesce((meta ->> 'awaiting_children')::boolean, false)
  returning true into parked;
  if coalesce(parked, false) then
    perform pgmq.send('agent_run_ticks', jsonb_build_object('run_id', p_run_id));
    return true;
  end if;
  return false;
end
$$;

revoke all on function public.agent_run_wake(uuid) from public;
grant execute on function public.agent_run_wake(uuid) to service_role;

alter table public.internal_agent_runs
  add column if not exists live_output text,
  add column if not exists live_output_at timestamptz;
