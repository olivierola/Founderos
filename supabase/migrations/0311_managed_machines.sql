-- 0311 — Les machines créées à la demande.
--
-- « Ajouter une machine » peut maintenant en CRÉER une : la plateforme lance
-- elle-même un conteneur team-machine (Docker de l'hôte, en mode auto-hébergé),
-- lui choisit un port et un jeton, et la range dans le parc. Ces colonnes
-- disent qui l'a créée et où elle en est ; une machine déclarée à la main les
-- laisse vides.

alter table public.machines
  -- Qui l'a créée : null (déclarée à la main) ou 'docker' (conteneur lancé par la plateforme).
  add column if not exists managed_by text check (managed_by is null or managed_by in ('docker')),
  -- Le nom du conteneur chez ce fournisseur (founderos-tm-<id>).
  add column if not exists managed_ref text,
  -- creating : le conteneur se prépare ; ready : il répond ; failed : voir last_error.
  add column if not exists provision_state text check (provision_state is null or provision_state in ('creating', 'ready', 'failed'));
