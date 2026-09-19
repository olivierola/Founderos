#!/usr/bin/env python3
"""
Build a Report Artisan HTML report from a content JSON file.

    python3 scripts/build_report.py content.json -o rapport.html

The output is one self-contained file: CSS, the runtime, the Editor.js bundle
and the content are all inlined, so it opens from disk, survives being emailed,
and works with no network. Use --static to drop the editor (smaller file,
read-only) when the report is a final deliverable nobody will edit.
"""

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "assets")

FONTS = (
    '<link rel="preconnect" href="https://fonts.googleapis.com">'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    '<link href="https://fonts.googleapis.com/css2?'
    "family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1"
    '&display=swap" rel="stylesheet">'
)

BLOCK_TYPES = {
    "paragraph", "lead", "header", "list", "checklist", "table", "quote", "delimiter",
    "banner", "chart", "kpis", "callout", "figure",
}
CHART_TYPES = {"bar", "hbar", "line", "area", "stackedBar", "donut"}
ACCENTS = {"blue", "indigo", "teal", "green", "amber", "rose", "plum", "slate"}
BANNER_STYLES = {
    "aurora", "waves", "grid", "topo", "dots", "prism", "ribbon",
    "strata", "arcs", "blueprint", "glow", "bars",
}


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def normalize(doc):
    """Let authors write the short form and still satisfy Editor.js.

    The list tool wants every item as {content, meta, items}; writing that by
    hand is tedious and easy to get wrong, so accept plain strings and fill in
    the rest here.
    """
    def norm_items(items):
        out = []
        for it in items or []:
            if isinstance(it, str):
                it = {"content": it}
            out.append({
                "content": it.get("content", ""),
                "meta": it.get("meta", {}),
                "items": norm_items(it.get("items")),
            })
        return out

    for b in doc.get("blocks") or []:
        d = b.setdefault("data", {})
        if b.get("type") == "paragraph" and d.pop("lead", False):
            b["type"] = "lead"
        if b.get("type") == "list":
            d.setdefault("style", "unordered")
            d.setdefault("meta", {})
            d["items"] = norm_items(d.get("items"))
        elif b.get("type") == "checklist":
            d["items"] = [
                {"text": it, "checked": False} if isinstance(it, str) else
                {"text": it.get("text", ""), "checked": bool(it.get("checked"))}
                for it in d.get("items") or []
            ]
        elif b.get("type") == "table":
            d.setdefault("withHeadings", True)
    return doc


def validate(doc):
    """Return a list of problems. Warnings guide; errors stop the build."""
    errors, warnings = [], []

    if not doc.get("title"):
        errors.append("`title` is required — it becomes the report's <h1>.")
    if doc.get("accent") and doc["accent"] not in ACCENTS:
        errors.append("accent %r unknown; pick one of %s" % (doc["accent"], sorted(ACCENTS)))
    hero = doc.get("heroBanner")
    if hero and hero.get("style") and hero["style"] not in BANNER_STYLES:
        errors.append("heroBanner.style %r unknown; pick one of %s"
                      % (hero["style"], sorted(BANNER_STYLES)))

    blocks = doc.get("blocks") or []
    if not blocks:
        errors.append("`blocks` is empty — a report needs content.")

    charts = 0
    for i, b in enumerate(blocks):
        t = b.get("type")
        d = b.get("data") or {}
        where = "blocks[%d] (%s)" % (i, t)
        if t not in BLOCK_TYPES:
            errors.append("%s: unknown block type; allowed: %s" % (where, sorted(BLOCK_TYPES)))
            continue
        if t == "chart":
            charts += 1
            ct = d.get("type", "bar")
            if ct not in CHART_TYPES:
                errors.append("%s: chart type %r unknown; allowed: %s" % (where, ct, sorted(CHART_TYPES)))
            series = d.get("series") or []
            cats = d.get("categories") or []
            if ct == "donut":
                if not (d.get("items") or series):
                    errors.append("%s: donut needs `items` or a single series" % where)
            else:
                if not cats:
                    errors.append("%s: `categories` is required" % where)
                if not series:
                    errors.append("%s: `series` is required" % where)
                for s in series:
                    if len(s.get("data") or []) != len(cats):
                        errors.append("%s: series %r has %d points for %d categories"
                                      % (where, s.get("name"), len(s.get("data") or []), len(cats)))
            if len(series) > 8:
                errors.append("%s: %d series — the palette holds 8; fold the tail into "
                              '"Autres" or split the chart' % (where, len(series)))
            if ct == "hbar":
                longest = max([len(str(x)) for x in cats] or [0])
                if longest > 34:
                    warnings.append("%s: a category label is %d characters — it will be "
                                    "truncated at 34. Shorten it or move the detail to the caption."
                                    % (where, longest))
            if d.get("showValues") and len(series) > 1:
                warnings.append("%s: `showValues` with %d series — labels collide inside a "
                                "category band, so they are dropped. The tooltip already has them."
                                % (where, len(series)))
            if ct == "donut" and len(d.get("items") or []) > 6:
                warnings.append("%s: %d parts in a donut — past six, an `hbar` reads better."
                                % (where, len(d.get("items") or [])))
            if not d.get("title"):
                warnings.append("%s: no `title` — a chart without a title makes the reader guess." % where)
            if not d.get("caption"):
                warnings.append("%s: no `caption` — say what the chart shows, not what it is." % where)
        if t == "banner" and d.get("style") and d["style"] not in BANNER_STYLES:
            errors.append("%s: banner style %r unknown; allowed: %s"
                          % (where, d["style"], sorted(BANNER_STYLES)))
        if t == "kpis":
            items = d.get("items") or []
            n = len(items)
            if n == 0:
                errors.append("%s: no items" % where)
            elif n > 5:
                warnings.append("%s: %d tiles — past four they stop reading as a glance." % (where, n))
            # A tile is roughly 170px wide; long strings wrap and unbalance the row.
            for j, k in enumerate(items):
                for field, cap in (("label", 26), ("deltaLabel", 14), ("deltaNote", 14), ("note", 34)):
                    val = k.get(field)
                    if isinstance(val, str) and len(val) > cap:
                        warnings.append("%s: item %d `%s` is %d characters (keep it under ~%d) — "
                                        "it will wrap onto a second line."
                                        % (where, j, field, len(val), cap))
        if t == "figure" and not (d.get("src") or d.get("alt")):
            warnings.append("%s: neither `src` nor `alt` — the placeholder will be blank." % where)

    if charts == 0:
        warnings.append("No chart in the report. If there are numbers in the text, "
                        "one of them probably wants to be a chart.")
    return errors, warnings


def build(doc, static=False):
    css = read(os.path.join(ASSETS, "report.css"))
    runtime = read(os.path.join(ASSETS, "runtime.js"))
    shell = read(os.path.join(ASSETS, "shell.html"))
    vendor = "" if static else read(os.path.join(ASSETS, "..", "scripts", "vendor", "editorjs.bundle.js"))

    payload = json.dumps(doc, ensure_ascii=False).replace("</", "<\\/")

    out = shell
    if static:
        # Strip the toolbar from the template *before* anything is inlined —
        # doing it afterwards means the pattern can match inside runtime.js.
        out = re.sub(r"<!--RA_BAR_START-->.*?<!--RA_BAR_END-->", "", out, flags=re.S)
    out = out.replace("<!--RA_BAR_START-->", "").replace("<!--RA_BAR_END-->", "")
    for key, val in [
        ("__LANG__", doc.get("lang", "fr")),
        ("__THEME__", "dark" if doc.get("theme") == "dark" else "light"),
        ("__ACCENT__", doc.get("accent", "blue")),
        ("__TYPEFACE__", doc.get("typeface", "editorial")),
        ("__TITLE__", doc.get("title", "Rapport")),
        ("__FONTS__", FONTS),
        ("__FONTS_JSON__", json.dumps(FONTS)),
    ]:
        out = out.replace(key, val)
    # big payloads last, and via a function so backslashes in the content are
    # never interpreted as regex escapes
    for key, val in [("__CSS__", css), ("__VENDOR__", vendor), ("__RUNTIME__", runtime), ("__DOC__", payload)]:
        out = out.replace(key, val)

    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("content", help="path to the content JSON")
    ap.add_argument("-o", "--out", default=None, help="output HTML path")
    ap.add_argument("--static", action="store_true", help="read-only build (no editor, smaller file)")
    ap.add_argument("--check", action="store_true", help="validate only, write nothing")
    args = ap.parse_args()

    try:
        doc = json.loads(read(args.content))
    except json.JSONDecodeError as exc:
        print("JSON invalide dans %s : %s" % (args.content, exc), file=sys.stderr)
        return 2

    doc = normalize(doc)
    errors, warnings = validate(doc)
    for w in warnings:
        print("  ~ %s" % w, file=sys.stderr)
    if errors:
        for e in errors:
            print("  ✗ %s" % e, file=sys.stderr)
        print("\n%d erreur(s) — rien n'a été écrit." % len(errors), file=sys.stderr)
        return 1
    if args.check:
        print("OK — %d blocs valides." % len(doc.get("blocks") or []))
        return 0

    out = args.out or os.path.splitext(args.content)[0] + ".html"
    html = build(doc, static=args.static)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("%s  (%.0f Ko, %d blocs)" % (out, len(html.encode("utf-8")) / 1024, len(doc.get("blocks") or [])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
