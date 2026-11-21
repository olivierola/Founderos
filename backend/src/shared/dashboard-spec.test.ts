// Les dashboards d'agents (dashboard-spec.ts) : ce que les agents déposent est
// validé et normalisé, les seuils donnent un état, les paramètres se
// remplacent, la consigne dit tout ce qu'il faut à l'agent.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyParameters, buildDashboardBrief, DASHBOARD_TEMPLATES, nextLayout, normalizeWidgetData, statusOf, WIDGET_KINDS,
} from "../edge/_shared/dashboard-spec.ts";

describe("dashboards : les données d'un composant", () => {
  it("KPI : nombres en texte acceptés, champs inutiles écartés", () => {
    const r = normalizeWidgetData("kpi", { value: "72,5", unit: "%", delta: "3", trend: ["1", 2, "x", 4], status: "warn", junk: 1 });
    assert.ok("data" in r);
    assert.deepEqual(r.data, { value: 72.5, unit: "%", delta: 3, delta_label: undefined, trend: [1, 2, 4], status: "warn", caption: undefined });
  });

  it("un JSON en texte est relu ; une donnée vide est refusée avec la raison", () => {
    assert.ok("data" in normalizeWidgetData("gauge", '{"value": 81}'));
    const bad = normalizeWidgetData("line", { labels: ["a"], series: [] });
    assert.ok("error" in bad && /series vide/.test(bad.error));
  });

  it("courbe : les séries trop courtes sont complétées, huit au plus", () => {
    const r = normalizeWidgetData("line", {
      labels: ["L", "M", "M"],
      series: Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, data: [1] })),
    });
    assert.ok("data" in r);
    const d = r.data as { series: Array<{ data: number[] }> };
    assert.equal(d.series.length, 8);
    assert.deepEqual(d.series[0].data, [1, 0, 0]);
  });

  it("anneau : six parts au plus, le reste dans « Autres »", () => {
    const r = normalizeWidgetData("donut", { items: Array.from({ length: 9 }, (_, i) => ({ label: `p${i}`, value: 10 - i })) });
    assert.ok("data" in r);
    const items = (r.data as { items: Array<{ label: string; value: number }> }).items;
    assert.equal(items.length, 6);
    assert.deepEqual(items[5], { label: "Autres", value: 5 + 4 + 3 + 2 });
  });

  it("alertes : les sévérités usuelles sont ramenées à trois", () => {
    const r = normalizeWidgetData("alerts", { items: [{ title: "a", severity: "warning" }, { title: "b", severity: "high" }, { title: "c" }] });
    assert.ok("data" in r);
    assert.deepEqual((r.data as { items: Array<{ severity: string }> }).items.map((i) => i.severity), ["warn", "critical", "info"]);
  });

  it("tableau : sans colonnes, elles viennent de la première ligne", () => {
    const r = normalizeWidgetData("table", { rows: [{ pod: "api-1", restarts: 4, _status: "warn" }] });
    assert.ok("data" in r);
    assert.deepEqual((r.data as { columns: unknown[] }).columns, [{ key: "pod", label: "pod" }, { key: "restarts", label: "restarts" }]);
  });
});

describe("dashboards : seuils, paramètres, consigne", () => {
  it("l'état vient des seuils, dans un sens ou dans l'autre", () => {
    const up = { thresholds: { warn: 70, critical: 90 } };
    assert.equal(statusOf(50, up), "ok");
    assert.equal(statusOf(75, up), "warn");
    assert.equal(statusOf(95, up), "critical");
    const down = { thresholds: { warn: 85, critical: 75, direction: "below" as const } };
    assert.equal(statusOf(80, down), "warn");
    assert.equal(statusOf(70, down), "critical");
    assert.equal(statusOf(95, down, "critical"), "critical", "l'état donné par l'agent l'emporte");
    assert.equal(statusOf(95, undefined), undefined);
  });

  it("les {{paramètres}} se remplacent ; un paramètre sans valeur reste visible", () => {
    const p = [{ key: "cluster", label: "Cluster", value: "prod-eu-1" }, { key: "ns", label: "Namespace" }];
    assert.equal(applyParameters("CPU de {{cluster}} dans {{ ns }}", p), "CPU de prod-eu-1 dans {{ ns }}");
  });

  it("la consigne porte le contexte, les paramètres, chaque composant et son format", () => {
    const brief = buildDashboardBrief(
      { id: "d1", name: "Cluster {{cluster}}", usage_context: "Lu par les SRE.", parameters: [{ key: "cluster", label: "Cluster", value: "prod" }] },
      [{ id: "w1", kind: "kpi", title: "CPU", instructions: "CPU de {{cluster}}", config: { unit: "%", thresholds: { warn: 70, critical: 90 } }, data: { value: 40 }, filled_at: "2026-11-18T08:00:00Z" }],
      "Tout va bien.",
    );
    assert.match(brief, /^# Dashboard « Cluster prod »/);
    assert.match(brief, /Lu par les SRE/);
    assert.match(brief, /Cluster \(cluster\) = prod/);
    assert.match(brief, /\[w1\] KPI « CPU »/);
    assert.match(brief, /CPU de prod/);
    assert.match(brief, /Seuils : au-dessus de 70/);
    assert.match(brief, /Valeur précédente/);
    assert.match(brief, /N'invente JAMAIS un chiffre/);
  });

  it("les modèles du catalogue n'utilisent que des types connus et tiennent sur 12 colonnes", () => {
    for (const t of DASHBOARD_TEMPLATES) {
      for (const w of t.widgets) {
        assert.ok((WIDGET_KINDS as readonly string[]).includes(w.kind), `${t.key} : ${w.kind}`);
        assert.ok(w.layout && w.layout.x + w.layout.w <= 12, `${t.key} : ${w.title} déborde`);
        assert.ok(w.instructions.length > 10, `${t.key} : ${w.title} sans instructions`);
      }
    }
  });

  it("un nouveau composant se place sous les autres", () => {
    assert.deepEqual(nextLayout([{ x: 0, y: 0, w: 6, h: 3 }, { x: 6, y: 0, w: 6, h: 4 }], "kpi"), { x: 0, y: 4, w: 3, h: 2 });
  });
});
