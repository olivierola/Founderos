-- `internal_agents.sandbox_url` n'est plus modifiable par un membre — FOS-11.
--
-- CE QUI N'ALLAIT PAS
-- Cette colonne sert de base d'URL à TOUTES les requêtes du bac à sable
-- (internal-agent-run:995, précédence : agent → app_config → env). La politique
-- de mise à jour de la table (migration 0220) l'ouvre à tout membre du
-- workspace. Un membre pouvait donc pointer son agent vers 169.254.169.254 ou
-- vers un service interne, et lire la réponse dans le fil de conversation :
-- une requête côté serveur vers l'adresse de son choix, avec restitution.
--
-- LE CORRECTIF
-- Un déclencheur BEFORE UPDATE/INSERT qui n'accepte une valeur que si elle vient
-- d'un appelant privilégié (service role, ou owner/admin du workspace) ET qu'elle
-- passe une validation de forme. Une tentative venue d'un membre ordinaire est
-- silencieusement ramenée à l'ancienne valeur plutôt que rejetée : l'écriture
-- porte souvent sur une ligne entière envoyée par l'UI, et faire échouer tout
-- l'enregistrement pour un champ que l'utilisateur n'a pas touché serait pire.
--
-- La validation de forme reste une seconde barrière, pas la première : le vrai
-- garde-fou est côté fonction edge (_shared/ssrf.ts), qui résout le DNS.

create or replace function public.internal_agents_guard_sandbox_url()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_role text;
  v_previous text := case when tg_op = 'UPDATE' then old.sandbox_url else null end;
begin
  -- Valeur inchangée : rien à juger.
  if tg_op = 'UPDATE' and new.sandbox_url is not distinct from old.sandbox_url then
    return new;
  end if;

  -- auth.uid() est NULL pour la clé service role et pour les fonctions internes :
  -- les tâches de plateforme gardent la main.
  if auth.uid() is null then
    return new;
  end if;

  select wm.role into v_role
  from public.workspace_members wm
  where wm.workspace_id = new.workspace_id and wm.user_id = auth.uid();

  if v_role in ('owner', 'admin') then
    -- Même pour un admin : une URL absolue en http(s), rien d'autre.
    if new.sandbox_url is null or new.sandbox_url ~* '^https?://[a-z0-9.\-]+(:[0-9]{1,5})?(/.*)?$' then
      return new;
    end if;
    raise exception 'sandbox_url must be an absolute http(s) URL';
  end if;

  -- Membre ordinaire : la valeur précédente est conservée.
  new.sandbox_url := v_previous;
  return new;
end $$;

drop trigger if exists trg_internal_agents_guard_sandbox_url on public.internal_agents;
create trigger trg_internal_agents_guard_sandbox_url
  before insert or update on public.internal_agents
  for each row execute function public.internal_agents_guard_sandbox_url();

comment on function public.internal_agents_guard_sandbox_url() is
  'sandbox_url pilote toutes les requêtes sortantes du bac à sable : réservée aux owners/admins, et de forme validée. Correctif FOS-11.';
