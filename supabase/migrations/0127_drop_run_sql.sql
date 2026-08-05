-- 0127_drop_run_sql.sql
-- La fonction Edge run-sql est supprimée (orpheline côté front, et son contrôle
-- d'accès validait l'admin d'UN workspace sans scoper le SELECT service-role à
-- ce workspace → lecture cross-tenant possible). On droppe aussi son unique
-- point d'entrée SQL (fos_run_select, security definer, créé en 0006) : plus
-- aucun appelant, autant fermer la porte.

drop function if exists public.fos_run_select(text);
