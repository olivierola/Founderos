// Small presentational helpers shared across Governance pages.
import { useState, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toneClass, PILL_TONES } from "./shared";

type Tone = keyof typeof PILL_TONES;

/** A soft, bordered status pill. Pass a metadata object ({ label, tone }). */
export function Pill({ meta, className }: { meta: { label: string; tone: Tone }; className?: string }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
      toneClass(meta.tone), className,
    )}>
      {meta.label}
    </span>
  );
}

/** Labelled form field wrapper. */
export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  return (
    <label className={cn("block space-y-1.5", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** Native <select> styled to match the Input component. */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select
      className={cn(
        "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

/** Turn a *_META record into <option> elements. */
export function metaOptions(meta: Record<string, { label: string }>) {
  return Object.entries(meta).map(([value, { label }]) => (
    <option key={value} value={value}>{label}</option>
  ));
}

// ── Generic create/edit dialog driven by a field schema ──────────────────────
type FieldType = "text" | "textarea" | "number" | "date" | "checkbox" | "select";
export interface FieldDef {
  key: string;
  label: string;
  type?: FieldType;                 // default "text"
  options?: Record<string, { label: string }> | { value: string; label: string }[];
  hint?: string;
  placeholder?: string;
  half?: boolean;                   // render at half width (two per row)
  required?: boolean;
}

function normOptions(o: FieldDef["options"]): { value: string; label: string }[] {
  if (!o) return [];
  if (Array.isArray(o)) return o;
  return Object.entries(o).map(([value, { label }]) => ({ value, label }));
}

/**
 * Schema-driven modal used by the entity list pages. Coerces number/checkbox
 * values and turns empty optional text into null on submit.
 */
export function FormDialog({ title, fields, initial, submitLabel = "Enregistrer", onClose, onSubmit }: {
  title: string;
  fields: FieldDef[];
  initial: Record<string, unknown>;
  submitLabel?: string;
  onClose: () => void;
  onSubmit: (values: Record<string, unknown>) => Promise<void> | void;
}) {
  const [form, setForm] = useState<Record<string, unknown>>(initial);
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  const required = fields.filter((f) => f.required);
  const invalid = required.some((f) => !String(form[f.key] ?? "").trim());

  const submit = async () => {
    if (invalid) return;
    setSaving(true);
    try {
      const out: Record<string, unknown> = {};
      for (const f of fields) {
        const raw = form[f.key];
        if (f.type === "number") out[f.key] = raw === "" || raw == null ? null : Number(raw);
        else if (f.type === "checkbox") out[f.key] = Boolean(raw);
        else out[f.key] = raw === "" || raw == null ? (f.required ? "" : null) : raw;
      }
      await onSubmit(out);
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {fields.map((f) => {
            const type = f.type ?? "text";
            const val = form[f.key];
            const span = f.half ? "col-span-1" : "col-span-2";
            if (type === "checkbox") {
              return (
                <label key={f.key} className={cn("flex items-center gap-2 pt-5", span)}>
                  <input type="checkbox" checked={Boolean(val)} onChange={(e) => set(f.key, e.target.checked)} className="h-4 w-4 rounded border-input" />
                  <span className="text-sm">{f.label}</span>
                </label>
              );
            }
            return (
              <Field key={f.key} label={f.label} hint={f.hint} className={span}>
                {type === "textarea" ? (
                  <Textarea value={String(val ?? "")} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} />
                ) : type === "select" ? (
                  <Select value={String(val ?? "")} onChange={(e) => set(f.key, e.target.value)}>
                    {normOptions(f.options).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                ) : (
                  <Input
                    type={type === "number" ? "number" : type === "date" ? "date" : "text"}
                    value={String(val ?? "")} placeholder={f.placeholder}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                )}
              </Field>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={submit} disabled={saving || invalid}>{saving ? "Enregistrement…" : submitLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
