-- 0193_banner_is_system.sql
-- The document's title is a property of the artifact, so it belongs to the
-- application, not to a block the model may or may not write. Letting the agent
-- author the header meant a document could open with no title, with two, or with
-- one that no longer matched the name in the gallery.
--
-- The header is now drawn by the viewer from the record itself, full-bleed. The
-- `banner` block type is withdrawn: add_block refuses it, and a legacy banner is
-- dropped from the body at render time.

update public.agent_skills
set system_prompt_extension = replace(
      system_prompt_extension,
      'TOUJOURS : ouvrir sur un banner puis une rangée de kpi ; refermer sur le callout de recommandation.',
      'TOUJOURS : ouvrir sur une rangée de kpi ; refermer sur le callout de recommandation.')
where workspace_id is null and slug in ('report-authoring', 'deck-authoring');

update public.agent_skills
set system_prompt_extension = system_prompt_extension || $DOC$

PAS DE BANDEAU DE TITRE. Le titre du document est porté par l'application, qui l'affiche en tête, pleine largeur. N'écris ni bloc de titre, ni page de garde, ni ligne « Rapport sur… » : commence directement par le premier constat. Le titre se donne à publish_artifact(title="…").$DOC$
where workspace_id is null and slug in ('report-authoring', 'deck-authoring');

-- The catalogue file the agent loads on demand must not keep offering it.
update public.agent_skill_files f
set content = regexp_replace(
      content,
      E'\\{"type":"banner"[^\\n]*\\n',
      '',
      'g'),
    updated_at = now()
from public.agent_skills s
where s.id = f.skill_id
  and s.workspace_id is null and s.slug in ('report-authoring', 'deck-authoring')
  and f.path = 'blocks.md';

update public.agent_skill_files f
set content = replace(
      content,
      '1. `banner` puis une rangée de `kpi` : le verdict et les chiffres d''emblée. Un',
      '1. Une rangée de `kpi` : le verdict et les chiffres d''emblée. Un'),
    updated_at = now()
from public.agent_skills s
where s.id = f.skill_id
  and s.workspace_id is null and s.slug = 'report-authoring'
  and f.path = 'principles.md';
