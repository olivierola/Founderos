import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Loader2, ArrowLeft, Check, Sparkles, Download, Table as TableIcon,
  Plus, Rows3, Columns3, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { useToast } from "@/components/ToastProvider";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useOfficeDoc } from "./useOfficeDoc";
import { OfficeAiPanel, type AiResult } from "./OfficeAiPanel";
import { type SpreadsheetContent, downloadBlob, sanitizeFilename } from "./shared";

export function SpreadsheetEditorPage() {
  const { docId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { workspaceId, projectId } = useCurrentContext();
  const { data: doc, isLoading, saving, savedAt, scheduleSave } = useOfficeDoc(docId, "spreadsheet");

  const [title, setTitle] = useState("");
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<(string | number | null)[][]>([]);
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    if (!doc) return;
    setTitle(doc.title);
    const c = doc.content as SpreadsheetContent;
    setColumns(c.columns ?? ["A", "B", "C", "D"]);
    setRows(c.rows ?? []);
  }, [doc?.id]);

  function persist(next: { columns?: string[]; rows?: (string | number | null)[][] }) {
    const content: SpreadsheetContent = {
      columns: next.columns ?? columns,
      rows: next.rows ?? rows,
    };
    scheduleSave({ content });
  }

  function setCell(r: number, c: number, value: string) {
    setRows((prev) => {
      const next = prev.map((row) => [...row]);
      next[r][c] = value;
      persist({ rows: next });
      return next;
    });
  }
  function setHeader(c: number, value: string) {
    setColumns((prev) => {
      const next = [...prev]; next[c] = value;
      persist({ columns: next });
      return next;
    });
  }
  function addRow() {
    setRows((prev) => { const next = [...prev, columns.map(() => "")]; persist({ rows: next }); return next; });
  }
  function addColumn() {
    setColumns((prevC) => {
      const nextC = [...prevC, colName(prevC.length)];
      setRows((prevR) => { const nextR = prevR.map((r) => [...r, ""]); persist({ columns: nextC, rows: nextR }); return nextR; });
      return nextC;
    });
  }
  function deleteRow(r: number) {
    setRows((prev) => { const next = prev.filter((_, i) => i !== r); persist({ rows: next }); return next; });
  }
  function deleteColumn(c: number) {
    setColumns((prevC) => {
      const nextC = prevC.filter((_, i) => i !== c);
      setRows((prevR) => { const nextR = prevR.map((row) => row.filter((_, i) => i !== c)); persist({ columns: nextC, rows: nextR }); return nextR; });
      return nextC;
    });
  }

  function onTitleChange(v: string) {
    setTitle(v);
    scheduleSave({ title: v || "Untitled spreadsheet" });
  }

  function applyAi(r: AiResult) {
    if (r.action === "set_spreadsheet" && r.spreadsheet) {
      const cols = r.spreadsheet.columns ?? columns;
      const rws = r.spreadsheet.rows ?? rows;
      setColumns(cols);
      setRows(rws);
      persist({ columns: cols, rows: rws });
      toast.success("Spreadsheet updated");
    }
  }

  function exportCsv() {
    downloadBlob(sanitizeFilename(title) + ".csv", toCsv(columns, rows), "text/csv");
    toast.success("CSV downloaded");
  }

  if (isLoading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (!doc) return <EmptyState icon={TableIcon} title="Spreadsheet not found" />;

  const contextText = `Columns: ${columns.join(", ")}\nRows:\n${rows.slice(0, 30).map((r) => r.join(" | ")).join("\n")}`;

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col">
      <div className="flex items-center gap-2 border-b border-border pb-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(-1)}><ArrowLeft className="h-4 w-4" /></Button>
        <span className="text-lg">{doc.emoji ?? "📊"}</span>
        <input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-lg font-semibold focus:outline-none"
          placeholder="Untitled spreadsheet"
        />
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {saving ? <><Loader2 className="h-3 w-3 animate-spin" /> Saving…</> : savedAt ? <><Check className="h-3 w-3" /> Saved</> : null}
        </span>
        <Button variant="outline" size="sm" onClick={exportCsv}><Download className="h-3.5 w-3.5" /> CSV</Button>
        <Button size="sm" variant={aiOpen ? "default" : "outline"} onClick={() => setAiOpen((v) => !v)}><Sparkles className="h-3.5 w-3.5" /> AI</Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Button size="sm" variant="outline" onClick={addRow}><Rows3 className="h-3.5 w-3.5" /> Row</Button>
            <Button size="sm" variant="outline" onClick={addColumn}><Columns3 className="h-3.5 w-3.5" /> Column</Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <table className="border-collapse text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 w-10 border border-border bg-muted/40" />
                  {columns.map((c, ci) => (
                    <th key={ci} className="group min-w-[120px] border border-border bg-muted/40 p-0">
                      <div className="flex items-center">
                        <input
                          value={c}
                          onChange={(e) => setHeader(ci, e.target.value)}
                          className="w-full bg-transparent px-2 py-1.5 text-xs font-semibold focus:bg-background focus:outline-none"
                        />
                        <button onClick={() => deleteColumn(ci)} className="px-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri} className="group/row">
                    <td className="sticky left-0 z-10 border border-border bg-muted/20 text-center">
                      <div className="flex items-center justify-center">
                        <span className="px-1 text-[10px] text-muted-foreground">{ri + 1}</span>
                        <button onClick={() => deleteRow(ri)} className="text-muted-foreground opacity-0 hover:text-destructive group-hover/row:opacity-100">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </td>
                    {columns.map((_, ci) => (
                      <td key={ci} className="border border-border p-0">
                        <input
                          value={(row[ci] ?? "") as string}
                          onChange={(e) => setCell(ri, ci, e.target.value)}
                          className="w-full bg-transparent px-2 py-1.5 focus:bg-primary/5 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary/40"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <button onClick={addRow} className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <Plus className="h-3 w-3" /> Add a row
              </button>
            )}
          </div>
        </div>

        <OfficeAiPanel
          open={aiOpen}
          onClose={() => setAiOpen(false)}
          kind="spreadsheet"
          docTitle={title}
          contextText={contextText}
          workspaceId={workspaceId}
          projectId={projectId}
          onResult={applyAi}
        />
      </div>
    </div>
  );
}

function colName(i: number): string {
  let s = ""; i = i + 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}
function toCsv(columns: string[], rows: (string | number | null)[][]): string {
  const esc = (c: unknown) => { const s = c == null ? "" : String(c); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}
