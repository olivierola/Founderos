import { useEffect, useRef, useState } from "react";
import { Bold, Italic, Heading1, Heading2, Heading3, List, ListOrdered, Quote, Link as LinkIcon, AlignLeft, AlignCenter, AlignRight, Type } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  INTERNAL_TABLES,
  METRIC_KEYS,
  CHART_PALETTES,
  TABLE_NUMERIC_COLUMNS,
  TABLE_DATE_COLUMNS,
  type Widget,
  type WidgetConfig,
  type WidgetType,
} from "./types";

const TYPES: { value: WidgetType; label: string }[] = [
  { value: "kpi", label: "KPI" },
  { value: "line", label: "Line chart" },
  { value: "bar", label: "Bar chart" },
  { value: "area", label: "Area chart" },
  { value: "pie", label: "Pie chart" },
  { value: "table", label: "Table" },
  { value: "markdown", label: "Text / heading" },
];

/** Wrap or insert markdown markers at the cursor in a textarea. */
function applyMarkdown(
  ref: React.RefObject<HTMLTextAreaElement>,
  current: string,
  setText: (v: string) => void,
  before: string,
  after = before,
  placeholder = "text",
) {
  const ta = ref.current;
  if (!ta) {
    setText(current + before + placeholder + after);
    return;
  }
  const start = ta.selectionStart ?? current.length;
  const end = ta.selectionEnd ?? current.length;
  const selected = current.slice(start, end) || placeholder;
  const next = current.slice(0, start) + before + selected + after + current.slice(end);
  setText(next);
  requestAnimationFrame(() => {
    ta.focus();
    ta.selectionStart = start + before.length;
    ta.selectionEnd = start + before.length + selected.length;
  });
}

const AGG_FNS = ["count", "count_distinct", "sum", "avg", "min", "max"] as const;
const BUCKET_UNITS = [
  { value: "none", label: "No time grouping" },
  { value: "day", label: "By day" },
  { value: "week", label: "By week" },
  { value: "month", label: "By month" },
] as const;

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  widget: Widget | null; // null = create
  onSave: (w: { type: WidgetType; title: string; config: WidgetConfig }) => Promise<void>;
}

export function WidgetConfigDialog({ open, onOpenChange, widget, onSave }: Props) {
  const [type, setType] = useState<WidgetType>("kpi");
  const [title, setTitle] = useState("");
  const [cfg, setCfg] = useState<WidgetConfig>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setType(widget?.type ?? "kpi");
      setTitle(widget?.title ?? "");
      setCfg(widget?.config ?? { source: { kind: "metrics", metric: "mrr_cents" }, format: "number" });
    }
  }, [open, widget]);

  const isChart = ["line", "bar", "area", "pie"].includes(type);
  const isData = type !== "markdown";
  const src = cfg.source ?? { kind: "metrics" };

  function setSource(patch: Partial<NonNullable<WidgetConfig["source"]>>) {
    setCfg({ ...cfg, source: { ...src, ...patch } as any });
  }

  async function handle() {
    setSaving(true);
    try {
      await onSave({ type, title, config: cfg });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{widget ? "Edit widget" : "Add widget"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Type */}
          <div>
            <label className="mb-1.5 block text-xs text-muted-foreground">Widget type</label>
            <div className="flex flex-wrap gap-1.5">
              {TYPES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setType(t.value)}
                  className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                    type === t.value ? "border-primary/40 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-secondary"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Title</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Widget title" />
          </div>

          {/* Markdown / Text / Heading */}
          {type === "markdown" && <MarkdownEditor cfg={cfg} setCfg={setCfg} />}

          {/* Data source */}
          {isData && (
            <>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Data source</label>
                <select
                  value={src.kind}
                  onChange={(e) => setSource({ kind: e.target.value as any })}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="metrics">Calculated metrics (time series)</option>
                  <option value="internal">FounderOS table</option>
                  <option value="project_db">Connected project DB</option>
                  <option value="static">Static values</option>
                </select>
              </div>

              {src.kind === "metrics" && (
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Metric</label>
                  <select
                    value={src.metric ?? "mrr_cents"}
                    onChange={(e) => setSource({ metric: e.target.value })}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-xs"
                  >
                    {METRIC_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">Returns a date/value series. For KPI, the latest value is used.</p>
                </div>
              )}

              {src.kind === "internal" && (
                <>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">Table</label>
                    <select
                      value={src.table ?? INTERNAL_TABLES[0]}
                      onChange={(e) => setSource({ table: e.target.value })}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-xs"
                    >
                      {INTERNAL_TABLES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  {(type === "kpi" || isChart) && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">Aggregate</label>
                        <select
                          value={src.aggregate?.fn ?? "count"}
                          onChange={(e) =>
                            setSource({ aggregate: { fn: e.target.value as any, column: src.aggregate?.column ?? "" } })
                          }
                          className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                        >
                          {AGG_FNS.map((f) => <option key={f} value={f}>{f}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">Column (cents fields → /100)</label>
                        <Input
                          value={src.aggregate?.column ?? ""}
                          onChange={(e) =>
                            setSource({ aggregate: { fn: src.aggregate?.fn ?? "count", column: e.target.value } })
                          }
                          placeholder="amount_cents"
                          className="h-9 font-mono text-xs"
                        />
                      </div>
                    </div>
                  )}
                  {isChart && (
                    <div>
                      <label className="mb-1 block text-xs text-muted-foreground">Group by (category axis)</label>
                      <Input
                        value={src.group_by ?? ""}
                        onChange={(e) => setSource({ group_by: e.target.value })}
                        placeholder="status / provider / plan_name"
                        className="h-9 font-mono text-xs"
                        list={`cols-${src.table}`}
                      />
                      <datalist id={`cols-${src.table}`}>
                        {(TABLE_NUMERIC_COLUMNS[src.table ?? ""] ?? []).map((c) => <option key={c} value={c} />)}
                      </datalist>
                    </div>
                  )}
                  {isChart && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">Time grouping</label>
                        <select
                          value={src.bucket?.unit ?? "none"}
                          onChange={(e) =>
                            setSource({ bucket: { column: src.bucket?.column ?? (TABLE_DATE_COLUMNS[src.table ?? ""]?.[0] ?? "created_at"), unit: e.target.value as any } })
                          }
                          className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                        >
                          {BUCKET_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                        </select>
                      </div>
                      {src.bucket && src.bucket.unit !== "none" && (
                        <div>
                          <label className="mb-1 block text-xs text-muted-foreground">Date column</label>
                          <Input
                            value={src.bucket.column}
                            onChange={(e) => setSource({ bucket: { column: e.target.value, unit: src.bucket!.unit } })}
                            placeholder="created_at"
                            className="h-9 font-mono text-xs"
                            list={`dates-${src.table}`}
                          />
                          <datalist id={`dates-${src.table}`}>
                            {(TABLE_DATE_COLUMNS[src.table ?? ""] ?? []).map((c) => <option key={c} value={c} />)}
                          </datalist>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {src.kind === "project_db" && (
                <>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">Table (in connected DB)</label>
                    <Input
                      value={src.table ?? ""}
                      onChange={(e) => setSource({ table: e.target.value })}
                      placeholder="profiles / orders / events"
                      className="h-9 font-mono text-xs"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Queried via PostgREST on your connected Supabase project — only tables in
                      the <span className="font-mono">public</span> schema are exposed. The auth
                      table is <span className="font-mono">auth.users</span> and is not reachable
                      this way; use a <span className="font-mono">profiles</span> table instead.
                    </p>
                  </div>
                  {(type === "kpi" || isChart) && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">Aggregate</label>
                        <select
                          value={src.aggregate?.fn ?? "count"}
                          onChange={(e) =>
                            setSource({ aggregate: { fn: e.target.value as any, column: src.aggregate?.column ?? "" } })
                          }
                          className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                        >
                          {AGG_FNS.map((f) => <option key={f} value={f}>{f}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">Column</label>
                        <Input
                          value={src.aggregate?.column ?? ""}
                          onChange={(e) =>
                            setSource({ aggregate: { fn: src.aggregate?.fn ?? "count", column: e.target.value } })
                          }
                          placeholder="amount"
                          className="h-9 font-mono text-xs"
                        />
                      </div>
                    </div>
                  )}
                  {isChart && (
                    <div>
                      <label className="mb-1 block text-xs text-muted-foreground">Group by (category axis)</label>
                      <Input
                        value={src.group_by ?? ""}
                        onChange={(e) => setSource({ group_by: e.target.value })}
                        placeholder="status / plan"
                        className="h-9 font-mono text-xs"
                      />
                    </div>
                  )}
                  {isChart && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">Time grouping</label>
                        <select
                          value={src.bucket?.unit ?? "none"}
                          onChange={(e) =>
                            setSource({ bucket: { column: src.bucket?.column ?? "created_at", unit: e.target.value as any } })
                          }
                          className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                        >
                          {BUCKET_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                        </select>
                      </div>
                      {src.bucket && src.bucket.unit !== "none" && (
                        <div>
                          <label className="mb-1 block text-xs text-muted-foreground">Date column</label>
                          <Input
                            value={src.bucket.column}
                            onChange={(e) => setSource({ bucket: { column: e.target.value, unit: src.bucket!.unit } })}
                            placeholder="created_at"
                            className="h-9 font-mono text-xs"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {src.kind === "static" && (
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Rows (JSON array)</label>
                  <textarea
                    value={JSON.stringify(src.rows ?? [{ label: "A", value: 10 }], null, 2)}
                    onChange={(e) => {
                      try {
                        setSource({ rows: JSON.parse(e.target.value) });
                      } catch {
                        /* ignore */
                      }
                    }}
                    rows={4}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                  />
                </div>
              )}

              {/* Chart axis mapping */}
              {isChart && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">X / category key</label>
                    <Input value={cfg.xKey ?? ""} onChange={(e) => setCfg({ ...cfg, xKey: e.target.value })} placeholder="date / label" className="h-9 font-mono text-xs" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">Y / value key</label>
                    <Input value={cfg.yKey ?? ""} onChange={(e) => setCfg({ ...cfg, yKey: e.target.value })} placeholder="value" className="h-9 font-mono text-xs" />
                  </div>
                  {(type === "bar" || type === "pie") && (
                    <div className="col-span-2">
                      <label className="mb-1 block text-xs text-muted-foreground">Emit filter column (click to cross-filter)</label>
                      <Input
                        value={cfg.emitFilterColumn ?? ""}
                        onChange={(e) => setCfg({ ...cfg, emitFilterColumn: e.target.value })}
                        placeholder="status / provider — defaults to group by"
                        className="h-9 font-mono text-xs"
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Chart colors */}
              {isChart && (
                <div>
                  <label className="mb-1.5 block text-xs text-muted-foreground">Colors</label>
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {CHART_PALETTES.map((p) => {
                      const active = JSON.stringify(cfg.colors ?? []) === JSON.stringify(p.name === "Default" ? [] : p.colors);
                      return (
                        <button
                          key={p.name}
                          type="button"
                          onClick={() => setCfg({ ...cfg, colors: p.name === "Default" ? [] : [...p.colors] })}
                          className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
                            active ? "border-primary/40 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-secondary"
                          }`}
                        >
                          <span className="flex">
                            {p.colors.slice(0, 4).map((c, i) => (
                              <span key={i} className="h-3 w-3 rounded-sm" style={{ background: c, marginLeft: i ? -3 : 0 }} />
                            ))}
                          </span>
                          {p.name}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(cfg.colors?.length ? cfg.colors : [type === "pie" ? CHART_PALETTES[0].colors[0] : CHART_PALETTES[0].colors[0]]).slice(0, type === "pie" ? 6 : 1).map((c, i) => (
                      <input
                        key={i}
                        type="color"
                        value={c}
                        onChange={(e) => {
                          const next = [...(cfg.colors?.length ? cfg.colors : CHART_PALETTES[0].colors)];
                          next[i] = e.target.value;
                          setCfg({ ...cfg, colors: next });
                        }}
                        className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent p-0.5"
                        title={`Color ${i + 1}`}
                      />
                    ))}
                    {type === "pie" && (
                      <span className="text-xs text-muted-foreground">first colors used per slice</span>
                    )}
                  </div>
                </div>
              )}

              {/* KPI formatting + formula */}
              {type === "kpi" && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">Format</label>
                    <select
                      value={cfg.format ?? "number"}
                      onChange={(e) => setCfg({ ...cfg, format: e.target.value as any })}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                    >
                      <option value="number">Number</option>
                      <option value="currency">Currency (€)</option>
                      <option value="percent">Percent</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">Formula (uses `value`)</label>
                    <Input value={cfg.formula ?? ""} onChange={(e) => setCfg({ ...cfg, formula: e.target.value })} placeholder="value * 12" className="h-9 font-mono text-xs" />
                  </div>
                  <label className="col-span-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={cfg.showDelta ?? false}
                      onChange={(e) => setCfg({ ...cfg, showDelta: e.target.checked })}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    Show variation vs previous point (time series)
                  </label>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handle} disabled={saving}>{widget ? "Save" : "Add widget"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface MarkdownEditorProps {
  cfg: WidgetConfig;
  setCfg: (c: WidgetConfig) => void;
}

function MarkdownEditor({ cfg, setCfg }: MarkdownEditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const text = cfg.text ?? "";
  const setText = (t: string) => setCfg({ ...cfg, text: t });
  const align = cfg.textAlign ?? "left";
  const headingMode = !!cfg.headingLevel;

  const toolBtn = "inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground";
  const activeBtn = "inline-flex h-7 w-7 items-center justify-center rounded bg-secondary text-foreground";

  return (
    <div className="space-y-2">
      {/* Mode toggle */}
      <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5 text-xs">
        <button
          type="button"
          onClick={() => setCfg({ ...cfg, headingLevel: undefined })}
          className={
            "inline-flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 transition-colors " +
            (!headingMode ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")
          }
        >
          <Type className="h-3.5 w-3.5" /> Rich text
        </button>
        <button
          type="button"
          onClick={() => setCfg({ ...cfg, headingLevel: cfg.headingLevel ?? 2 })}
          className={
            "inline-flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 transition-colors " +
            (headingMode ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")
          }
        >
          <Heading2 className="h-3.5 w-3.5" /> Heading only
        </button>
      </div>

      {/* Heading-mode controls */}
      {headingMode && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Level</span>
          <div className="flex gap-1">
            {[1, 2, 3, 4].map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => setCfg({ ...cfg, headingLevel: lvl as 1 | 2 | 3 | 4 })}
                className={cfg.headingLevel === lvl ? activeBtn + " px-2 w-auto" : toolBtn + " px-2 w-auto"}
              >
                H{lvl}
              </button>
            ))}
          </div>
          <span className="ml-2 text-muted-foreground">Align</span>
          <div className="flex gap-1">
            <button type="button" onClick={() => setCfg({ ...cfg, textAlign: "left" })} className={align === "left" ? activeBtn : toolBtn} title="Left">
              <AlignLeft className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => setCfg({ ...cfg, textAlign: "center" })} className={align === "center" ? activeBtn : toolBtn} title="Center">
              <AlignCenter className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => setCfg({ ...cfg, textAlign: "right" })} className={align === "right" ? activeBtn : toolBtn} title="Right">
              <AlignRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Rich text toolbar (markdown shortcuts) */}
      {!headingMode && (
        <div className="flex flex-wrap items-center gap-0.5 rounded-md border border-border bg-card p-1">
          <button type="button" className={toolBtn} title="Heading 1" onClick={() => applyMarkdown(taRef, text, setText, "# ", "", "Title")}>
            <Heading1 className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={toolBtn} title="Heading 2" onClick={() => applyMarkdown(taRef, text, setText, "## ", "", "Subtitle")}>
            <Heading2 className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={toolBtn} title="Heading 3" onClick={() => applyMarkdown(taRef, text, setText, "### ", "", "Section")}>
            <Heading3 className="h-3.5 w-3.5" />
          </button>
          <div className="mx-1 h-4 w-px bg-border" />
          <button type="button" className={toolBtn} title="Bold (**text**)" onClick={() => applyMarkdown(taRef, text, setText, "**")}>
            <Bold className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={toolBtn} title="Italic (*text*)" onClick={() => applyMarkdown(taRef, text, setText, "*")}>
            <Italic className="h-3.5 w-3.5" />
          </button>
          <div className="mx-1 h-4 w-px bg-border" />
          <button type="button" className={toolBtn} title="Bullet list" onClick={() => applyMarkdown(taRef, text, setText, "\n- ", "", "item")}>
            <List className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={toolBtn} title="Numbered list" onClick={() => applyMarkdown(taRef, text, setText, "\n1. ", "", "item")}>
            <ListOrdered className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={toolBtn} title="Quote" onClick={() => applyMarkdown(taRef, text, setText, "\n> ", "", "quote")}>
            <Quote className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={toolBtn} title="Link" onClick={() => applyMarkdown(taRef, text, setText, "[", "](https://)", "label")}>
            <LinkIcon className="h-3.5 w-3.5" />
          </button>
          <div className="mx-1 h-4 w-px bg-border" />
          <div className="ml-auto flex gap-1">
            <button type="button" onClick={() => setCfg({ ...cfg, textAlign: "left" })} className={align === "left" ? activeBtn : toolBtn} title="Align left">
              <AlignLeft className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => setCfg({ ...cfg, textAlign: "center" })} className={align === "center" ? activeBtn : toolBtn} title="Align center">
              <AlignCenter className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => setCfg({ ...cfg, textAlign: "right" })} className={align === "right" ? activeBtn : toolBtn} title="Align right">
              <AlignRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={headingMode ? 2 : 7}
        placeholder={
          headingMode
            ? "Section heading…"
            : "# Title\n\nSupports **bold**, *italic*, lists, [links](https://example.com), tables, code blocks…"
        }
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      {!headingMode && text.trim() && (
        <p className="text-[11px] text-muted-foreground">
          Markdown is rendered live in the widget — supports GFM (tables, task lists, strikethrough).
        </p>
      )}
    </div>
  );
}
