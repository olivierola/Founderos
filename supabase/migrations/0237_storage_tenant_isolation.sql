-- Cloisonnement du stockage par client — correctifs FOS-03 et FOS-04.
--
-- CE QUI N'ALLAIT PAS
-- Sept buckets, une seule condition dans leurs politiques : le nom du bucket.
--
--     create policy "Members manage rag-docs"
--     on storage.objects for all to authenticated
--     using (bucket_id = 'rag-docs');
--
-- « to authenticated » ne veut rien dire ici : l'inscription est ouverte, donc
-- la population visée est le public d'Internet. N'importe quel compte pouvait
-- lister, télécharger, écraser et supprimer les documents de TOUS les
-- workspaces — base de connaissances (rag-docs) et jeux d'entraînement
-- (ft-datasets) compris. Cinq autres buckets étaient de surcroît déclarés
-- `public = true`, donc lisibles sans même un compte.
--
-- CE QUE FAIT CETTE MIGRATION
--   1. rag-docs et ft-datasets : lecture ET écriture cadrées sur le projet
--      propriétaire, déduit du premier segment du chemin. Les deux buckets
--      écrivent déjà en `{project_id}/…` (RagCenter, DocumentAiWorkspace,
--      AssetsHub, AgentBuilder, aiops/db.ts) : aucun fichier à déplacer, aucun
--      appel applicatif à changer — ils lisent par URL signée.
--   2. test-artifacts : repassé en privé, sans politique. Le bucket n'est
--      référencé nulle part hors de sa propre migration ; seule la clé service
--      role y accède désormais.
--   3. Les quatre buckets dont l'URL publique est déjà écrite dans des
--      documents (office-media, marketing-visuals, pj-attachments,
--      skill-recordings) : la lecture reste publique — la basculer casserait
--      les URL déjà stockées, et cela demande une migration de données traitée
--      à part. En revanche l'écriture et la suppression passent de « tout
--      compte » à « le déposant seul », ce qui ferme la destruction et la
--      substitution de fichiers entre clients.
--
-- NOTE D'EXPLOITATION : tout ce qui a été déposé dans rag-docs et ft-datasets
-- avant cette migration doit être considéré comme potentiellement exfiltré.

-- ── Aide : ce projet est-il accessible à l'appelant ? ────────────────────────
-- security definer parce que la politique doit lire `projects` et
-- `workspace_members` sans être elle-même soumise à leur RLS. search_path figé
-- (cf. FOS-17) : une fonction definer qui laisse la résolution de noms ouverte
-- est détournable.
create or replace function public.can_access_project_storage(p_folder text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1
    from public.projects p
    join public.workspace_members wm on wm.workspace_id = p.workspace_id
    where wm.user_id = auth.uid()
      -- Le premier segment du chemin doit être un UUID de projet. Un chemin
      -- qui n'en est pas un ne ressemble à rien de légitime : on refuse.
      and p_folder ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      and p.id::text = p_folder
  );
$$;

revoke all on function public.can_access_project_storage(text) from public;
grant execute on function public.can_access_project_storage(text) to authenticated;

-- ── 1. rag-docs — la base de connaissances des clients ───────────────────────
update storage.buckets set public = false where id = 'rag-docs';

drop policy if exists "Members manage rag-docs" on storage.objects;

create policy "rag-docs read own project"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'rag-docs'
    and public.can_access_project_storage((storage.foldername(name))[1])
  );

create policy "rag-docs write own project"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'rag-docs'
    and public.can_access_project_storage((storage.foldername(name))[1])
  );

-- `using` juge la ligne existante, `with check` la ligne d'après : les deux
-- sont nécessaires, sinon on déplace un objet hors de son projet en le mettant
-- à jour.
create policy "rag-docs update own project"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'rag-docs'
    and public.can_access_project_storage((storage.foldername(name))[1])
  )
  with check (
    bucket_id = 'rag-docs'
    and public.can_access_project_storage((storage.foldername(name))[1])
  );

create policy "rag-docs delete own project"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'rag-docs'
    and public.can_access_project_storage((storage.foldername(name))[1])
  );

-- ── 2. ft-datasets — les jeux d'entraînement de fine-tuning ──────────────────
update storage.buckets set public = false where id = 'ft-datasets';

drop policy if exists "aiops ft-datasets members" on storage.objects;

create policy "ft-datasets read own project"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'ft-datasets'
    and public.can_access_project_storage((storage.foldername(name))[1])
  );

create policy "ft-datasets write own project"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ft-datasets'
    and public.can_access_project_storage((storage.foldername(name))[1])
  );

create policy "ft-datasets update own project"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'ft-datasets'
    and public.can_access_project_storage((storage.foldername(name))[1])
  )
  with check (
    bucket_id = 'ft-datasets'
    and public.can_access_project_storage((storage.foldername(name))[1])
  );

create policy "ft-datasets delete own project"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'ft-datasets'
    and public.can_access_project_storage((storage.foldername(name))[1])
  );

-- ── 3. test-artifacts — bucket sans appelant ────────────────────────────────
-- Captures et vidéos des exécutions E2E : elles filment l'application connectée.
-- Aucune référence dans le code hors de la migration 0042 ; on le ferme.
update storage.buckets set public = false where id = 'test-artifacts';
drop policy if exists "test-artifacts select" on storage.objects;
drop policy if exists "test-artifacts insert" on storage.objects;
drop policy if exists "test-artifacts update" on storage.objects;
drop policy if exists "test-artifacts delete" on storage.objects;

-- ── 4. Buckets à URL publique déjà diffusée ─────────────────────────────────
-- La lecture reste ouverte (les URL sont écrites dans des documents Plate, des
-- posts marketing et des pièces jointes de tickets ; les fermer sans migrer ces
-- références casserait l'affichage). Ce qu'on ferme ici, c'est la modification
-- et la suppression : `auth.role() = 'authenticated'` laissait n'importe quel
-- compte écraser ou détruire le fichier de n'importe quel autre client.
--
-- `owner` est renseigné par Storage avec l'uid du déposant. Les objets déposés
-- par la clé service role ont owner NULL et restent hors d'atteinte des rôles
-- API, ce qui est le comportement voulu.
--
-- Les politiques sont écrites une par une, pas en boucle : une migration de
-- sécurité ne doit REMPLACER que des droits existants, jamais en créer. Une
-- boucle uniforme aurait donné à skill-recordings des droits d'écriture qu'il
-- n'avait pas — il n'a qu'une politique de lecture, ses fichiers étant déposés
-- par la clé service role depuis test-runner-poll.

-- office-media : upload + update + delete existaient, ouverts à tout compte.
drop policy if exists "office-media upload" on storage.objects;
drop policy if exists "office-media update" on storage.objects;
drop policy if exists "office-media delete" on storage.objects;

create policy "office-media insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'office-media');
create policy "office-media update own" on storage.objects for update to authenticated
  using (bucket_id = 'office-media' and owner = auth.uid())
  with check (bucket_id = 'office-media' and owner = auth.uid());
create policy "office-media delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'office-media' and owner = auth.uid());

-- marketing-visuals : idem.
drop policy if exists "marketing-visuals upload" on storage.objects;
drop policy if exists "marketing-visuals update" on storage.objects;
drop policy if exists "marketing-visuals delete" on storage.objects;

create policy "marketing-visuals insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'marketing-visuals');
create policy "marketing-visuals update own" on storage.objects for update to authenticated
  using (bucket_id = 'marketing-visuals' and owner = auth.uid())
  with check (bucket_id = 'marketing-visuals' and owner = auth.uid());
create policy "marketing-visuals delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'marketing-visuals' and owner = auth.uid());

-- pj-attachments : upload + delete existaient ; pas d'update, on n'en ajoute pas.
drop policy if exists "pj-attachments upload" on storage.objects;
drop policy if exists "pj-attachments delete" on storage.objects;

create policy "pj-attachments insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'pj-attachments');
create policy "pj-attachments delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'pj-attachments' and owner = auth.uid());

-- skill-recordings : rien à resserrer côté écriture (aucune politique n'existait
-- pour les rôles API). Sa lecture publique reste le point ouvert — c'est le
-- bucket le plus sensible des quatre, puisqu'il filme l'écran d'un opérateur au
-- travail, et il devrait passer en privé dès que les URL déjà stockées auront
-- été migrées vers des URL signées.

comment on function public.can_access_project_storage(text) is
  'Cadrage du stockage : le premier segment du chemin est un id de projet, et l''appelant doit être membre du workspace qui le possède. Correctif FOS-03.';
