import { useEffect, useRef, useState } from "react";
import { Check, X, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CrmProperty, CrmRecord, SelectOption } from "./objectModel";

// A single editable table cell. Renders the value for a property type and, when
// edited, calls onChange with the new value. Relations are handled separately.
export function Cell({
  property, record, value, onChange, relationLabels, onEditRelation,
}: {
  property: CrmProperty;
  record: CrmRecord;
  value: unknown;
  onChange: (v: unknown) => void;
  relationLabels?: string[];
  onEditRelation?: () => void;
}) {
  const [editing, setEditing] = useState(false);

  // ── display + inline editors by type ──
  switch (property.type) {
    case "checkbox":
      return (
        <button onClick={() => onChange(!value)} className="flex h-full w-full items-center px-3">
          <span className={cn("flex h-4 w-4 items-center justify-center rounded border", value ? "border-primary bg-primary text-primary-foreground" : "border-input")}>
            {value ? <Check className="h-3 w-3" /> : null}
          </span>
        </button>
      );

    case "select":
      return <SelectCell property={property} value={value as string} onChange={onChange} />;

    case "multi_select":
      return <MultiSelectCell property={property} value={(value as string[]) ?? []} onChange={onChange} />;

    case "rating":
      return (
        <div className="flex items-center gap-0.5 px-3">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} onClick={() => onChange(n === value ? 0 : n)}>
              <span className={cn("text-sm", (Number(value) || 0) >= n ? "text-amber-400" : "text-muted-foreground/40")}>★</span>
            </button>
          ))}
        </div>
      );

    case "relation":
      return (
        <button onClick={onEditRelation} className="flex h-full w-full items-center gap-1 px-3 text-left text-sm hover:bg-muted/40">
          {(relationLabels ?? []).length === 0
            ? <span className="text-muted-foreground/50">—</span>
            : (relationLabels ?? []).map((l, i) => <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-xs">{l}</span>)}
        </button>
      );

    case "url":
    case "email":
    case "phone":
    case "text":
    case "long_text":
    case "number":
    case "currency":
    case "percent":
    case "date":
    case "datetime":
    default:
      if (editing) {
        return (
          <InlineInput
            type={property.type}
            initial={value}
            onCommit={(v) => { onChange(v); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        );
      }
      return (
        <button onClick={() => setEditing(true)} className="flex h-full w-full items-center px-3 text-left text-sm hover:bg-muted/30">
          <DisplayValue property={property} value={value} />
        </button>
      );
  }
}

function DisplayValue({ property, value }: { property: CrmProperty; value: unknown }) {
  if (value == null || value === "") return <span className="text-muted-foreground/40">—</span>;
  switch (property.type) {
    case "currency": return <span>{formatCurrency(Number(value))}</span>;
    case "percent": return <span>{Number(value)}%</span>;
    case "number": return <span className="tabular-nums">{String(value)}</span>;
    case "date": return <span>{formatDate(value as string)}</span>;
    case "datetime": return <span>{new Date(value as string).toLocaleString()}</span>;
    case "url":
      return <span className="inline-flex items-center gap-1 text-primary"><span className="truncate">{String(value)}</span><ExternalLink className="h-3 w-3 shrink-0" /></span>;
    case "email": return <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{String(value)}</span>;
    case "phone": return <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{String(value)}</span>;
    default: return <span className="truncate">{String(value)}</span>;
  }
}

function InlineInput({ type, initial, onCommit, onCancel }: {
  type: string; initial: unknown; onCommit: (v: unknown) => void; onCancel: () => void;
}) {
  const [val, setVal] = useState(initial == null ? "" : String(initial));
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); (ref.current as HTMLInputElement)?.select?.(); }, []);

  function commit() {
    if (type === "number" || type === "currency" || type === "percent") {
      const n = val.trim() === "" ? null : Number(val);
      onCommit(Number.isNaN(n) ? null : n);
    } else { onCommit(val.trim() === "" ? null : val); }
  }
  const inputType = type === "date" ? "date" : type === "datetime" ? "datetime-local"
    : type === "email" ? "email" : type === "url" ? "url" : type === "phone" ? "tel"
    : (type === "number" || type === "currency" || type === "percent") ? "number" : "text";

  if (type === "long_text") {
    return (
      <textarea ref={ref as React.RefObject<HTMLTextAreaElement>} value={val} onChange={(e) => setVal(e.target.value)}
        onBlur={commit} onKeyDown={(e) => { if (e.key === "Escape") onCancel(); if (e.key === "Enter" && e.metaKey) commit(); }}
        rows={3} className="w-full resize-none bg-background px-3 py-1 text-sm focus:outline-none" />
    );
  }
  return (
    <input ref={ref as React.RefObject<HTMLInputElement>} type={inputType} value={val} onChange={(e) => setVal(e.target.value)}
      onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") onCancel(); }}
      className="h-full w-full bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary" />
  );
}

function SelectCell({ property, value, onChange }: { property: CrmProperty; value: string; onChange: (v: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const opt = property.options.find((o) => o.value === value);
  return (
    <div className="relative h-full">
      <button onClick={() => setOpen((o) => !o)} className="flex h-full w-full items-center px-3 text-left hover:bg-muted/30">
        {opt ? <Pill o={opt} /> : <span className="text-muted-foreground/40 text-sm">—</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-2 top-full z-20 mt-0.5 w-48 rounded-md border border-border bg-popover p-1 shadow-lg">
            <button onClick={() => { onChange(null); setOpen(false); }} className="block w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted">Clear</button>
            {property.options.map((o) => (
              <button key={o.value} onClick={() => { onChange(o.value); setOpen(false); }} className="block w-full rounded px-2 py-1 text-left hover:bg-muted"><Pill o={o} /></button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MultiSelectCell({ property, value, onChange }: { property: CrmProperty; value: string[]; onChange: (v: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const set = new Set(value);
  function toggle(v: string) { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); onChange([...n]); }
  return (
    <div className="relative h-full">
      <button onClick={() => setOpen((o) => !o)} className="flex h-full w-full flex-wrap items-center gap-1 px-3 text-left hover:bg-muted/30">
        {value.length === 0 ? <span className="text-muted-foreground/40 text-sm">—</span>
          : value.map((v) => { const o = property.options.find((x) => x.value === v); return o ? <Pill key={v} o={o} /> : null; })}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-2 top-full z-20 mt-0.5 w-48 rounded-md border border-border bg-popover p-1 shadow-lg">
            {property.options.map((o) => (
              <button key={o.value} onClick={() => toggle(o.value)} className="flex w-full items-center justify-between rounded px-2 py-1 hover:bg-muted">
                <Pill o={o} />{set.has(o.value) && <Check className="h-3 w-3 text-primary" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Pill({ o }: { o: SelectOption }) {
  return <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: (o.color || "#64748b") + "22", color: o.color || undefined }}>{o.label}</span>;
}

export function formatCurrency(n: number): string {
  if (Number.isNaN(n)) return "";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}
function formatDate(s: string): string { const d = new Date(s); return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(); }
