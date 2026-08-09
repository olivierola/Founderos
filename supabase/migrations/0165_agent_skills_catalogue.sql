-- 0165_agent_skills_catalogue.sql
-- Prepares agent_skills to hold a LARGE system catalogue (the skills_repo packs
-- imported by 0166-0172).
--
-- The problem it fixes: the only uniqueness on skills is
--   unique (workspace_id, slug)
-- and in Postgres NULLs are distinct in a unique index — so every system skill
-- (workspace_id = null) could be inserted any number of times with the same
-- slug. Nothing upstream deduped them, which is why an interrupted/replayed
-- import leaves duplicate rows and why `on conflict` could not be used at all.
--
-- After this migration a system skill's slug is genuinely unique, so imports
-- are idempotent UPSERTS (`on conflict (slug) where workspace_id is null`)
-- instead of delete-then-insert — which matters because deleting a skill row
-- cascades to agent_skill_activations, i.e. it would silently detach the skill
-- from every agent that had it enabled.

-- ── 1. Collapse existing duplicates, keeping the oldest row per slug ──────────
-- (Activations pointing at a discarded duplicate are re-pointed first so no
-- agent loses a skill it had enabled.)
update public.agent_skill_activations a
   set skill_id = keep.id
  from public.agent_skills dup
  join lateral (
        select k.id from public.agent_skills k
         where k.workspace_id is null and k.slug = dup.slug
         order by k.created_at, k.id
         limit 1
       ) keep on true
 where a.skill_id = dup.id
   and dup.workspace_id is null
   and keep.id <> dup.id
   and not exists (
        select 1 from public.agent_skill_activations x
         where x.agent_id = a.agent_id and x.skill_id = keep.id);

delete from public.agent_skill_activations a
 using public.agent_skills dup
 where a.skill_id = dup.id
   and dup.workspace_id is null
   and exists (
        select 1 from public.agent_skills k
         where k.workspace_id is null and k.slug = dup.slug
           and (k.created_at, k.id) < (dup.created_at, dup.id));

delete from public.agent_skills dup
 where dup.workspace_id is null
   and exists (
        select 1 from public.agent_skills k
         where k.workspace_id is null and k.slug = dup.slug
           and (k.created_at, k.id) < (dup.created_at, dup.id));

-- ── 2. Real uniqueness for system skills ─────────────────────────────────────
create unique index if not exists idx_agent_skills_system_slug
  on public.agent_skills (slug) where workspace_id is null;

-- ── 3. Catalogue browsing at 900+ skills ─────────────────────────────────────
create index if not exists idx_agent_skills_category on public.agent_skills(category);
create index if not exists idx_agent_skills_system   on public.agent_skills(is_system) where workspace_id is null;
