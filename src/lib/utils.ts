import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number, currency = "EUR") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
}

export function formatCompact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Export an array of flat objects to a downloadable CSV file. */
export function exportToCsv(rows: Record<string, unknown>[], filename: string) {
  if (rows.length === 0) {
    downloadBlob("", filename, "text/csv");
    return;
  }
  const headers = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const escape = (v: unknown) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\n");
  downloadBlob(csv, filename, "text/csv;charset=utf-8");
}

export function exportToJson(data: unknown, filename: string) {
  downloadBlob(JSON.stringify(data, null, 2), filename, "application/json");
}
