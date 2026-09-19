-- Limitation de débit sur les surfaces publiques — correctif FOS-15.
--
-- CE QUI N'ALLAIT PAS
-- Aucune des 99 fonctions edge ne comptait les requêtes. Les quotas en crédits
-- (migration 0194) couvrent les runs d'agents internes, mais pas les chemins
-- publics — et ce sont eux qui appellent un LLM sans authentification :
-- rag-chat en mode widget, onboarding-agent, et (avant le correctif FOS-10)
-- daily-briefing et ai-cost-optimization. La facture est celle du client, et
-- rien n'arrêtait la boucle. S'y ajoutaient les insertions non bornées de
-- ingest-session-replay et l'absence de ralentissement sur les points
-- d'authentification par jeton.
--
-- LE CHOIX D'IMPLÉMENTATION
-- Un compteur en base plutôt qu'un Redis : la plateforme n'a pas de cache
-- partagé, et les fonctions edge sont sans état entre deux invocations. Le coût
-- est d'un aller-retour Postgres par requête publique, ce qui est négligeable
-- devant l'appel LLM que la limite protège.
--
-- Le compteur est à fenêtre fixe (« combien d'appels depuis le début de la
-- minute »), pas glissante. Une fenêtre fixe autorise jusqu'à deux fois le
-- plafond à cheval sur deux fenêtres ; c'est accepté ici — l'objectif est
-- d'arrêter l'abus, pas de lisser le trafic à la requête près.

create table if not exists public.rate_limit_counters (
  -- La clé porte déjà la dimension : "ragchat:<public_key>", "replay:<project>",
  -- "runnertoken:<ip>". Une seule table pour toutes les limites.
  bucket_key   text        not null,
  window_start timestamptz not null,
  hits         int         not null default 0,
  primary key (bucket_key, window_start)
);

-- Les compteurs n'ont aucune valeur passé leur fenêtre ; l'index sert au ménage.
create index if not exists idx_rate_limit_window
  on public.rate_limit_counters(window_start);

alter table public.rate_limit_counters enable row level security;
-- Aucune politique : seule la clé service role écrit ici, et les rôles API
-- n'ont aucune raison de lire les compteurs des autres.

-- Incrémente et tranche en une seule instruction.
--
-- `insert … on conflict do update` est atomique : deux requêtes simultanées ne
-- peuvent pas lire 9, écrire 10 toutes les deux et passer à onze. C'est la
-- raison d'être de cette fonction plutôt qu'un select suivi d'un update côté
-- edge, qui aurait exactement ce défaut sous charge — c'est-à-dire au moment
-- précis où la limite compte.
create or replace function public.rate_limit_hit(
  p_key    text,
  p_limit  int,
  p_window_seconds int default 60
)
returns table (allowed boolean, hits int, retry_after_seconds int)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_start timestamptz;
  v_hits  int;
begin
  -- Début de la fenêtre courante, arrondi vers le bas.
  v_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.rate_limit_counters (bucket_key, window_start, hits)
  values (p_key, v_start, 1)
  on conflict (bucket_key, window_start)
  do update set hits = public.rate_limit_counters.hits + 1
  returning public.rate_limit_counters.hits into v_hits;

  return query select
    v_hits <= p_limit,
    v_hits,
    greatest(0, p_window_seconds - floor(extract(epoch from now() - v_start))::int);
end $$;

revoke all on function public.rate_limit_hit(text, int, int) from public;
grant execute on function public.rate_limit_hit(text, int, int) to service_role;

-- Ménage : les fenêtres passées ne servent plus à rien. Appelé par le cron
-- horaire ; une table de compteurs qui grossit indéfiniment finit par coûter
-- plus cher que les abus qu'elle prévient.
create or replace function public.prune_rate_limits()
returns void
language sql
security definer
set search_path = public, pg_catalog
as $$
  delete from public.rate_limit_counters where window_start < now() - interval '2 hours';
$$;

revoke all on function public.prune_rate_limits() from public;
grant execute on function public.prune_rate_limits() to service_role;

do $$
begin
  perform cron.schedule('prune-rate-limits', '17 * * * *', 'select public.prune_rate_limits()');
exception
  -- pg_cron absent en local : le ménage se fera au prochain déploiement.
  when invalid_schema_name or undefined_function then null;
  when others then null;
end $$;

comment on function public.rate_limit_hit(text, int, int) is
  'Compteur à fenêtre fixe, incrément et verdict atomiques. Correctif FOS-15.';
