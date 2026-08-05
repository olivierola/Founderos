-- Restructure the Report Designer skill (0152) into a proper multi-file,
-- progressive-disclosure skill: a lean overview in system_prompt_extension that
-- routes to focused playbook files loaded on demand via read_skill_file. Keeps
-- the prompt small until the agent actually builds a report.
--
-- Activations + the auto-activate trigger from 0152 are untouched (we UPDATE the
-- skill row rather than delete it, so no activation is lost).

update public.agent_skills
set system_prompt_extension = $DOC$You turn any analysis or result into a MODERN, PROFESSIONAL report — an executive-dashboard-grade page — using create_deliverable(kind="report"), whose content is a JSON document the app renders (KPI tiles, charts, tables, gauges, timelines, callouts).

WORKFLOW
1. Gather the real numbers with your tools first — never invent or flatter data.
2. Before writing the JSON, load the playbook you need (progressive disclosure — keep context lean):
   - read_skill_file(slug="report-designer", path="principles.md") — how to structure a report that reads like a dashboard.
   - read_skill_file(slug="report-designer", path="chart-selection.md") — pick the right chart for the data.
   - read_skill_file(slug="report-designer", path="schema.md") — the EXACT JSON content shape (fields, types).
   - read_skill_file(slug="report-designer", path="example.md") — a full worked example (executive summary).
3. Build content as the JSON string described in schema.md and save it with create_deliverable(kind="report"). Then reply with a SHORT summary — the full report opens as an artifact.

NON-NEGOTIABLE: lead with a 1-line summary + a row of KPI cards; put at least one chart in every analytical section; use a callout for the headline risk/win. A report that is only prose is a failure of this skill.$DOC$
where workspace_id is null and slug = 'report-designer';

-- Playbook files (idempotent upsert).
insert into public.agent_skill_files (skill_id, path, content, sort)
select s.id, v.path, v.content, v.sort
from public.agent_skills s
cross join (values
  ('principles.md', $DOC$# Report design principles

Build every report so it reads like an executive dashboard, top to bottom.

## 1. Lead with the answer
- Open with a ONE-LINE executive summary (the `summary` field): the conclusion, not the setup.
- Immediately follow with a row of 3-5 KPI cards — the headline numbers, each with its `delta` and `trend`. These are the first thing the reader sees. Never bury key figures in prose.

## 2. Show, don't tell
- Whenever a section has numbers, add a chart. One insight per chart. Give each chart a title that states the takeaway ("Revenue up 12% since the redesign"), not just the metric name.
- Prefer visuals over long paragraphs. Prose is connective tissue: 1-3 tight sentences per section, no filler, no superlatives.

## 3. Structure in sections
- Each section = a heading + optional short body + its visuals (kpis / charts / table / gauges / timeline / callout). Group related things; keep each section focused on one question.
- Typical order: Executive summary (KPIs) → Trends (charts) → Breakdown (composition chart + table) → Risks/next steps (callout + timeline).

## 4. Use the right element for the job
- KPI cards: the 3-5 numbers that matter most.
- Charts: trends and comparisons (see chart-selection.md).
- Table: line-item detail only — never for the headline.
- Gauge: a score or completion out of 100.
- Timeline: a sequence of dated events.
- Callout: flag the single most important risk or win (tone info/success/warning/danger).

## 5. Data integrity
- Every number comes from a real tool result. Give the sample size behind a percentage. If data is missing or uncertain, say so in a callout — never fake it.$DOC$, 1),

  ('chart-selection.md', $DOC$# Choosing the right chart

Match the chart `type` to the question the data answers.

- **line** — a trend over time (one or few series). "How did X evolve?"
- **area** — a trend over time where the magnitude/volume matters; stack for cumulative composition over time.
- **bar** — compare discrete categories at a point in time. "Which segment is biggest?"
- **bar + stacked:true** — composition over time or across categories (e.g. OPEX by type per month). Each bar's segments sum to the total.
- **donut / pie** — a SINGLE breakdown of a whole into parts (≤6 slices). Don't use for time series.
- **radar** — compare several entities across the same 3-8 dimensions (scorecards).
- **scatter** — correlation between two numeric variables.

Rules of thumb:
- More than ~7 categories → bar, not pie.
- Time on the x-axis → line/area/stacked bar, never pie.
- Two series with very different scales → two charts, not one.
- Variance / bridge (budget → actual with +/- steps): use a bar chart with the steps as data points and name the deltas in the section body (a dedicated waterfall type is not available).
- Always set `x` to the category key and list the numeric keys in `series`; every `data` row is an object keyed by `<x>` plus each series key.$DOC$, 2),

  ('schema.md', $DOC$# Report content schema

`create_deliverable(kind="report", content=<JSON string>)`. The content is a JSON string of:

{
  "title": "string",
  "subtitle": "string, optional (e.g. 'Q3 · Shopify store')",
  "author": "string, optional (your agent name)",
  "summary": "string — 1-3 sentence executive summary",
  "sections": [
    {
      "heading": "string",
      "body": "markdown paragraph(s), optional",
      "kpis": [
        { "label": "string", "value": "string|number", "delta": "string, optional (e.g. '+12%')", "trend": "up|down|flat" }
      ],
      "gauges": [
        { "label": "string", "value": 72, "max": 100, "tone": "good|bad|neutral" }
      ],
      "charts": [
        {
          "type": "bar|line|area|pie|donut|radar|scatter",
          "title": "string",
          "x": "the category key (e.g. 'month')",
          "series": ["key1", "key2"],
          "data": [ { "month": "Jan", "key1": 12, "key2": 8 } ],
          "stacked": false,
          "unit": "string, optional (e.g. '€', '%')"
        }
      ],
      "table": { "title": "string, optional", "columns": ["A", "B"], "rows": [["x", 1]] },
      "timeline": [
        { "date": "2026-06-01", "title": "string", "detail": "string, optional", "tone": "info|success|warning|danger" }
      ],
      "callout": { "tone": "info|success|warning|danger", "text": "string" }
    }
  ]
}

Notes:
- Every field except title/summary/sections is optional; include only what the data justifies.
- A section may combine several of kpis/charts/table/gauges/timeline/callout.
- `data` values must be real numbers (not strings) for charts to render.
- You can also embed a chart inside a markdown deliverable with a fenced block: ```chart\n{ "type":"bar", "x":"month", "series":["mrr"], "data":[...] }\n``` — but for a full report, prefer kind="report".$DOC$, 3),

  ('example.md', $DOC$# Worked example — executive summary report

A compact but complete report. Adapt the structure; use your real data.

{
  "title": "Executive summary",
  "subtitle": "FY26 · company-wide",
  "author": "Finance Briefer",
  "summary": "Revenue is tracking 3% ahead of plan and margin improved to 45.2%, but Q4 OPEX is accelerating and one variance driver needs attention.",
  "sections": [
    {
      "heading": "Headline KPIs",
      "kpis": [
        { "label": "FY26 Revenue YTD", "value": "$280M", "delta": "+3% vs plan", "trend": "up" },
        { "label": "QTR YoY Growth", "value": "34.6%", "delta": "+2.1 pts", "trend": "up" },
        { "label": "FY26 OPEX YTD", "value": "$14M", "delta": "+8%", "trend": "up" },
        { "label": "FY26 Margin %", "value": "45.2%", "delta": "+1.4 pts", "trend": "up" }
      ]
    },
    {
      "heading": "Revenue forecast vs actuals",
      "body": "Actuals beat forecast in 8 of 12 months; the gap widened from June.",
      "charts": [
        { "type": "bar", "title": "Forecast vs actuals ($M)", "x": "month", "series": ["forecast", "actuals"],
          "data": [ { "month": "Jan", "forecast": 20, "actuals": 21 }, { "month": "Feb", "forecast": 22, "actuals": 23 }, { "month": "Mar", "forecast": 24, "actuals": 22 } ] }
      ]
    },
    {
      "heading": "OPEX composition",
      "charts": [
        { "type": "bar", "title": "OPEX by type per month", "x": "month", "series": ["salaries", "marketing", "infra"], "stacked": true,
          "data": [ { "month": "Jan", "salaries": 6, "marketing": 2, "infra": 1 }, { "month": "Feb", "salaries": 6, "marketing": 3, "infra": 1 } ] }
      ]
    },
    {
      "heading": "Budget variance analysis (YTD)",
      "table": {
        "title": "BVA summary",
        "columns": ["Line", "Actuals", "Forecast", "Variance", "Variance %"],
        "rows": [
          ["Gross profit", "$182M", "$204M", "-$21M", "11%"],
          ["EBITDA", "$167M", "$188M", "-$21M", "11%"],
          ["Net income", "$146M", "$164M", "-$18M", "11%"]
        ]
      },
      "callout": { "tone": "warning", "text": "Net income is 11% under forecast, driven mostly by the 'Unplanned Ext Event' variance — investigate before the board review." }
    }
  ]
}$DOC$, 4)
) as v(path, content, sort)
where s.workspace_id is null and s.slug = 'report-designer'
on conflict (skill_id, path) do update set content = excluded.content, sort = excluded.sort, updated_at = now();
