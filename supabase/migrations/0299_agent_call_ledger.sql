-- 0299 — Le registre des appels à effet d'un run : la reprise exacte.
--
-- Le moteur de tick (internal-agent-run) sauvegarde le transcrit après chaque
-- tour. Un worker tué PENDANT un tour perdait la trace de ce que ce tour avait
-- lancé (un e-mail, une fiche CRM, une publication), et la relivraison du tick
-- laissait le modèle le refaire. Chaque appel à effet est désormais noté ici
-- avant de partir (« started »), puis avec son résultat (« done »). À la
-- reprise, un appel resté sans résultat dans le transcrit reçoit le résultat
-- enregistré, ou un avertissement daté si son effet est inconnu.
--
-- Lié au run, supprimé avec lui. Service role seulement : un résultat d'outil
-- n'a rien à faire côté navigateur (même règle que 0297).
--
-- Sans cette table, le moteur se comporte comme avant.

create table if not exists public.internal_agent_call_ledger (
  run_id uuid not null references public.internal_agent_runs(id) on delete cascade,
  call_id text not null,
  tool text not null,
  status text not null default 'started' check (status in ('started', 'done')),
  result text,
  started_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key (run_id, call_id)
);

alter table public.internal_agent_call_ledger enable row level security;
revoke all on public.internal_agent_call_ledger from anon, authenticated;
