-- 0312 — Plus de « machine de la plateforme ».
--
-- Une machine avait une adresse vide quand elle désignait la machine que
-- l'opérateur branchait par l'environnement (TEAM_MACHINE_URL, TEAM_MACHINE_TOKEN)
-- ou par app_config.team_machine_url. Ce repli disparaît : chaque machine a son
-- adresse et son jeton, créée à la demande (0311) ou branchée à la main.
--
-- Les machines déclarées sans adresse et sans création à la demande ne sont
-- plus joignables : on le dit sur leur ligne, pour que l'onglet Machines
-- invite à les compléter (adresse et jeton) ou à les remplacer.

delete from public.app_config where key = 'team_machine_url';

update public.machines
   set last_error = 'Machine de la plateforme retirée : donnez-lui une adresse et un jeton, ou créez une machine à la demande.',
       updated_at = now()
 where url is null
   and managed_by is null;
