-- 0186_report_designer_visual.sql
-- The Report Designer skill was written before the renderer learned comparison
-- grids, positioning matrices and figures — and before markdown analyses were
-- refused outright. Agents kept shipping a valid report JSON whose sections were
-- one long `body` of prose, KPIs flattened into a markdown table, no chart:
-- the reader got a wall of text where a dashboard was promised.
--
-- Three changes, all pointing the same way — the numbers belong in the typed
-- blocks, never in the sentences:
--   1. the overview states the hard rule and the refusal that now enforces it;
--   2. principles.md gets the "block, not prose" discipline + the new blocks;
--   3. a new blocks.md documents comparison / matrix / images, which did not
--      exist when the skill was written.

update public.agent_skills
set system_prompt_extension = $DOC$You turn any analysis or result into a MODERN, PROFESSIONAL report — an executive-dashboard-grade page — using create_deliverable(kind="report"), whose content is a JSON document the app renders with React components (KPI tiles, charts, tables, comparison grids, 2×2 matrices, gauges, timelines, figures, callouts).

HARD RULE: there is NO markdown deliverable. Anything you write is kind="report", whose content is the JSON document described in schema.md — a note, a recap and a full analysis all take that same shape. The option does not exist in the tool and a markdown deliverable is refused outright. json/code/url are for data, code and links, not for writing.

WHEN YOU HAVE NUMBERS, they go in the BLOCKS, not in the sentences: a figure becomes a kpi, a chart series, a table row, a matrix point. `body` carries the interpretation — why the number matters. Blocks are not a quota: a section of plain prose is perfectly legitimate when there is nothing to plot. Use a block when it says something a paragraph cannot.

WORKFLOW
1. Gather the real numbers with your tools first — never invent or flatter data. Re-read what you already collected with recall_findings rather than searching again.
2. Before writing the JSON, load the playbook you need (progressive disclosure — keep context lean):
   - read_skill_file(slug="report-designer", path="principles.md") — how to structure a report that reads like a dashboard.
   - read_skill_file(slug="report-designer", path="blocks.md") — every block type and when each one is the right answer.
   - read_skill_file(slug="report-designer", path="chart-selection.md") — pick the right chart for the data.
   - read_skill_file(slug="report-designer", path="schema.md") — the EXACT JSON content shape (fields, types).
   - read_skill_file(slug="report-designer", path="example.md") — a full worked example (executive summary).
3. Build it SECTION BY SECTION with report_section(...) — call it the moment you have the facts for a section, while your sources are still readable: the transcript is compacted as the run grows, and a figure you have not written into a block is a figure you have lost. Then finalize with create_deliverable(kind="report") with NO content.
4. Reply with a SHORT summary — the full report opens as an artifact.

ALWAYS: lead with a one-line summary; close on a recommendation, never on a summary of what you did. When the subject carries figures, show them — a KPI row up front, a chart in the sections that compare or trend, a table for the detail, a callout for the headline risk or win.$DOC$
where workspace_id is null and slug = 'report-designer';

insert into public.agent_skill_files (skill_id, path, content, sort)
select s.id, v.path, v.content, v.sort
from public.agent_skills s
cross join (values
  ('principles.md', $DOC$# Report design principles

A report is read by someone who will stop after the first screen. Design for that.

## The shape

1. **Executive summary** — the verdict in one or two sentences, then a KPI row.
   A reader who stops here must already have the answer.
2. **One section per subject** — each OPENS with its finding in one bold
   sentence, then the evidence that supports it.
3. **A synthesis section** that CONFRONTS the findings: what they mean together,
   what contradicts what. This is the section that makes it an analysis rather
   than an inventory.
4. **A closing section** with a ranked, actionable recommendation. Never end on a
   summary of what you did — end on what to do.

## Block when the block says more

The most common failure is writing every figure into `body` and leaving the
sections empty of blocks: the renderer has nothing to draw and the reader gets a
wall of text. The opposite failure is a chart with three bars invented to fill a
quota. Neither is design.

- A figure belongs in `kpis`. Never write "le CA atteint 4,4 T$" in a paragraph
  when it can be a KPI card.
- A series over time or a comparison of magnitudes belongs in `charts`.
- Rows of detail belong in `table`.
- "X versus Y versus Z" belongs in `comparison`, not a hand-built table.
- A positioning judgement belongs in `matrix`.
- `body` carries the INTERPRETATION: why the number matters, what it implies.
  A section that is only prose is fine when there is genuinely nothing to plot —
  a context section, a method note, a qualitative finding. Just never bury a
  figure in a sentence when a block would show it.

## Analyse, do not inventory

"Rival A charges $99/seat" is data. "Rival A's $99/seat puts them out of the SMB
segment we own, which is why their published logos are all enterprise" is
analysis. The report is judged on the second kind of sentence.

## Honesty

Every figure carries its source and its date. A figure you could not find is
written "non publié" — never estimated, never rounded into existence. A reader
who catches one invented number stops trusting the whole document.$DOC$, 1),

  ('blocks.md', $DOC$# The blocks, and when each is the right answer

Every block below is a field of a section object. Use the one that matches the
SHAPE of what you are saying.

## kpis — the figures that matter
`"kpis": [{ "label": "Impact annuel genAI", "value": "2,6–4,4 T$", "delta": "+18%", "trend": "up" }]`
Three to six per report, in the FIRST section. These are the numbers a reader
must leave with. Not fifteen — a KPI row with fifteen tiles is a table.

## charts — trends and magnitudes
`"charts": [{ "type": "bar", "title": "Adoption par secteur", "x": "secteur", "series": ["adoption"], "data": [{ "secteur": "Droit", "adoption": 80 }] }]`
Types: line (over time), bar (comparison), area (cumulative), donut/pie
(composition), radar (multi-dimension scores), scatter (correlation).
See chart-selection.md. At least one per analytical section.

## table — the detail rows
`"table": { "title": "…", "columns": ["Secteur", "Adoption", "Source"], "rows": [["Droit", "80%", "Thomson Reuters"]] }`
For anything a reader may want to scan line by line. Put the source column in
the table rather than repeating "(source : …)" in every sentence.

## comparison — X versus Y versus Z
`"comparison": { "title": "…", "columns": ["Nous", "Rival A", "Rival B"], "highlight": 0,
  "rows": [{ "label": "Missions planifiées", "cells": [true, "partiel", false] }] }`
Booleans render as real ✓/✕; `highlight` marks our own column. ALWAYS prefer
this to a hand-built table when comparing players on criteria — it is what the
reader is really looking for.

## matrix — a positioning map
`"matrix": { "x_label": "Autonomie réelle", "y_label": "Profondeur métier",
  "x_low": "assiste", "x_high": "exécute", "y_low": "générique", "y_high": "spécialisé",
  "quadrants": ["Copilotes", "Plateformes", "Verticales", "Outils"],
  "items": [{ "label": "Nous", "x": 80, "y": 70, "highlight": true }] }`
Coordinates are 0-100, origin bottom-left. The block no chart can replace: a
scatter has no quadrant names. One per report, in the synthesis section.

## images — evidence, not decoration
`"images": [{ "url": "https://…/screenshot.png", "caption": "ce que ça montre", "source": "site" }]`
Use when the subject is visual: a product screenshot, a pricing page, a diagram
found while researching. The url must point DIRECTLY at the image file, never at
the page containing it. Always caption it. Two to four well-chosen figures beat
a gallery. For an image you need to GENERATE, use create_artifact(kind="image")
instead — it becomes its own openable artifact.

## gauges, timeline, callout
- `gauges`: scores and completion (0-100).
- `timeline`: a sequence of dated events.
- `callout`: `{ "tone": "info|success|warning|danger", "text": "…" }` — the
  headline risk or win. One per report, in the closing section.$DOC$, 2)
) as v(path, content, sort)
where s.workspace_id is null and s.slug = 'report-designer'
on conflict (skill_id, path) do update
  set content = excluded.content, sort = excluded.sort, updated_at = now();

-- Reading order: principles → blocks → chart-selection → schema → example.
-- blocks.md takes slot 2, so the three files after it shift by one (0153 left
-- them at 2/3/4 and a duplicate sort makes the listing order arbitrary).
update public.agent_skill_files f
set sort = case f.path
             when 'chart-selection.md' then 3
             when 'schema.md' then 4
             when 'example.md' then 5
             else f.sort
           end,
    updated_at = now()
from public.agent_skills s
where s.id = f.skill_id
  and s.workspace_id is null and s.slug = 'report-designer'
  and f.path in ('chart-selection.md', 'schema.md', 'example.md');

-- schema.md (0153) still ends on "you can embed a chart inside a markdown
-- deliverable" — the one file the agent reads for the exact shape, contradicting
-- everything above it. Surgical rewrite rather than a full re-upsert, so the
-- rest of that playbook stays exactly as written.
update public.agent_skill_files f
set content = replace(
      f.content,
      '- You can also embed a chart inside a markdown deliverable with a fenced block:',
      '- A section''s `body` may carry a chart as a fenced block (there is NO markdown deliverable):'
    ),
    updated_at = now()
from public.agent_skills s
where s.id = f.skill_id
  and s.workspace_id is null and s.slug = 'report-designer'
  and f.path = 'schema.md'
  and f.content like '%markdown deliverable%';
