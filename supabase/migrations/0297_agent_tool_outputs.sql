-- 0297 — Les gros résultats d'outils d'un run, conservés en entier.
--
-- Un résultat d'outil plus long que le plafond du transcrit (12 000
-- caractères) était coupé au milieu, et le milieu perdu pour de bon. Le moteur
-- de tick (internal-agent-run) le conserve désormais ici, en entier, et le
-- modèle reçoit l'extrait habituel avec une référence (« out_… ») qu'il relit
-- avec read_tool_output — par plage ou par recherche.
--
-- Pas dans internal_agent_run_events exprès : la timeline relit tous les
-- événements d'un run toutes les 2,5 s, et des sorties de centaines de kilo-
-- octets y alourdiraient chaque lecture. Lié au run, supprimé avec lui.
--
-- Écriture et lecture par la service role seulement (le moteur et l'outil) :
-- une sortie d'outil peut contenir ce qu'un guardrail aurait masqué dans la
-- timeline, elle n'a rien à faire côté navigateur.
--
-- Sans cette table, le moteur se comporte comme avant : l'insertion échoue,
-- le résultat est coupé, aucune référence n'est donnée.

create table if not exists public.internal_agent_tool_outputs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.internal_agent_runs(id) on delete cascade,
  ref text not null,
  tool text not null,
  label text,
  content text not null,
  size int not null default 0,
  created_at timestamptz not null default now(),
  unique (run_id, ref)
);

alter table public.internal_agent_tool_outputs enable row level security;
revoke all on public.internal_agent_tool_outputs from anon, authenticated;
