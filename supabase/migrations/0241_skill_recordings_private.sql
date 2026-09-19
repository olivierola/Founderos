-- Les enregistrements de démonstration passent en privé — solde de FOS-04.
--
-- CE QUI N'ALLAIT PAS
-- Le bucket `skill-recordings` était créé avec `public = true` et sa politique
-- de lecture était `using (bucket_id = 'skill-recordings')` : aucune condition
-- de rôle, donc lisible **anonymement** par quiconque connaît ou devine une URL.
--
-- C'est le plus sensible des buckets publics. Le module d'apprentissage par la
-- démonstration filme l'écran pendant qu'un humain manipule ses outils réels :
-- une capture toutes les quelques secondes, pendant qu'il ouvre son CRM, sa
-- banque, sa messagerie. Le commentaire d'origine justifiait l'ouverture par
-- « lecture publique (comme test-artifacts) pour que la timeline affiche les
-- vignettes » — la timeline n'a en réalité besoin que d'une URL signée.
--
-- CE QUE FAIT CETTE MIGRATION
-- Le bucket passe en privé. La lecture est cadrée par jointure : le premier
-- segment du chemin est l'id de l'enregistrement (`{recording_id}/0001.jpg`,
-- écrit par test-runner-poll), et l'appelant doit être membre du workspace qui
-- le possède. Aucun fichier n'a besoin d'être déplacé.
--
-- Les écritures continuent de passer par la clé service role (le recorder pousse
-- ses vignettes via l'edge function), qui contourne RLS.
--
-- NOTE D'EXPLOITATION : les vignettes déjà déposées ont été exposées
-- publiquement. Si des captures montrent des identifiants ou des données
-- personnelles, les purger vaut mieux que les protéger rétroactivement.

update storage.buckets set public = false where id = 'skill-recordings';

drop policy if exists "skill-recordings select" on storage.objects;

create policy "skill-recordings read own workspace"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'skill-recordings'
    and exists (
      select 1
      from public.skill_recordings r
      join public.workspace_members wm on wm.workspace_id = r.workspace_id
      where wm.user_id = auth.uid()
        -- Le premier segment doit être un UUID : un chemin qui n'en est pas un
        -- ne ressemble à rien que le recorder ait pu écrire.
        and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        and r.id::text = (storage.foldername(name))[1]
    )
  );

-- ── Les URL déjà écrites en base ────────────────────────────────────────────
-- `skill_recording_events.screenshot_url` contient une URL publique complète
-- (…/storage/v1/object/public/skill-recordings/<chemin>). Elle cesse de
-- fonctionner maintenant que le bucket est privé. On la réduit à son chemin :
-- le front sait désormais signer un chemin à l'affichage, et sait aussi
-- reconnaître une URL héritée. Les deux formes coexistent donc sans casse, mais
-- normaliser dès maintenant évite de traîner deux conventions.
update public.skill_recording_events
   set screenshot_url = regexp_replace(
         screenshot_url,
         '^.*/storage/v1/object/(public|sign)/skill-recordings/',
         ''
       )
 where screenshot_url like '%/storage/v1/object/%/skill-recordings/%';

comment on column public.skill_recording_events.screenshot_url is
  'Chemin de la vignette DANS le bucket privé skill-recordings (ex. "<recording_id>/0007.jpg"), à signer à l''affichage. Les lignes antérieures à la migration 0241 pouvaient contenir une URL publique complète ; le front tolère les deux.';
