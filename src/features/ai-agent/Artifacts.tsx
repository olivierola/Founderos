import { useState } from "react";
import {
  FileText, FileJson, Table as TableIcon, Code as CodeIcon, FileDown,
  Download, Copy, Check, ChevronDown, ChevronRight,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface AiArtifact {
  id: string;
  message_id: string;
  kind: "document" | "json" | "table" | "code" | "csv";
  title: string;
  content: string | null;
  data: any | null;
  language: string | null;
  created_at: string;
}

const KIND_META: Record<AiArtifact["kind"], { icon: any; label: string }> = {
  document: { icon: FileText, label: "Document" },
  json: { icon: FileJson, label: "JSON" },
  table: { icon: TableIcon, label: "Table" },
  code: { icon: CodeIcon, label: "Code" },
  csv: { icon: FileDown, label: "CSV" },
};

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitize(s: string): string {
  return (s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)) || "artifact";
}

/** Renders the set of artifacts attached to one assistant message. */
export function MessageArtifacts({
  artifacts,
  onOpenDocument,
}: {
  artifacts: AiArtifact[];
  onOpenDocument: (markdown: string, title: string) => void;
}) {
  if (artifacts.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {artifacts.map((a) => (
        <ArtifactCard key={a.id} artifact={a} onOpenDocument={onOpenDocument} />
      ))}
    </div>
  );
}

function ArtifactCard({
  artifact,
  onOpenDocument,
}: {
  artifact: AiArtifact;
  onOpenDocument: (markdown: string, title: string) => void;
}) {
  const meta = KIND_META[artifact.kind];
  const Icon = meta.icon;
  const [open, setOpen] = useState(artifact.kind === "table");
  const [copied, setCopied] = useState(false);

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card/60 px-3 py-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          <Icon className="h-4 w-4 shrink-0 text-[hsl(var(--primary-soft))]" />
          <span className="truncate text-sm font-medium">{artifact.title}</span>
          <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {artifact.language || meta.label}
          </span>
        </button>
        <ArtifactActions
          artifact={artifact}
          copied={copied}
          onCopy={copy}
          onOpenDocument={onOpenDocument}
        />
      </div>

      {open && (
        <div className="max-h-[420px] overflow-auto p-3">
          <ArtifactBody artifact={artifact} />
        </div>
      )}
    </div>
  );
}

function ArtifactActions({
  artifact, copied, onCopy, onOpenDocument,
}: {
  artifact: AiArtifact;
  copied: boolean;
  onCopy: (text: string) => void;
  onOpenDocument: (markdown: string, title: string) => void;
}) {
  const { kind, title } = artifact;

  if (kind === "document") {
    const md = artifact.content ?? "";
    return (
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="outline" onClick={() => onOpenDocument(md, title)}>
          <FileText className="h-3.5 w-3.5" /> Open
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onCopy(md)}>
          {copied ? <Check className="h-3.5 w-3.5 text-[hsl(var(--accent-2))]" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    );
  }

  if (kind === "json") {
    const text = JSON.stringify(artifact.data ?? {}, null, 2);
    return (
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => onCopy(text)}>
          {copied ? <Check className="h-3.5 w-3.5 text-[hsl(var(--accent-2))]" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
        <Button size="sm" variant="outline" onClick={() => download(sanitize(title) + ".json", text, "application/json")}>
          <Download className="h-3.5 w-3.5" /> JSON
        </Button>
      </div>
    );
  }

  if (kind === "table") {
    const csv = artifact.content ?? tableToCsv(artifact.data);
    return (
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => onCopy(csv)}>
          {copied ? <Check className="h-3.5 w-3.5 text-[hsl(var(--accent-2))]" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
        <Button size="sm" variant="outline" onClick={() => download(sanitize(title) + ".csv", csv, "text/csv")}>
          <Download className="h-3.5 w-3.5" /> CSV
        </Button>
      </div>
    );
  }

  if (kind === "csv") {
    const csv = artifact.content ?? "";
    return (
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => onCopy(csv)}>
          {copied ? <Check className="h-3.5 w-3.5 text-[hsl(var(--accent-2))]" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
        <Button size="sm" variant="outline" onClick={() => download(sanitize(title) + ".csv", csv, "text/csv")}>
          <Download className="h-3.5 w-3.5" /> CSV
        </Button>
      </div>
    );
  }

  // code
  const code = artifact.content ?? "";
  const ext = artifact.language ? extForLang(artifact.language) : "txt";
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button size="sm" variant="ghost" onClick={() => onCopy(code)}>
        {copied ? <Check className="h-3.5 w-3.5 text-[hsl(var(--accent-2))]" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
      <Button size="sm" variant="outline" onClick={() => download(sanitize(title) + "." + ext, code, "text/plain")}>
        <Download className="h-3.5 w-3.5" /> File
      </Button>
    </div>
  );
}

function ArtifactBody({ artifact }: { artifact: AiArtifact }) {
  switch (artifact.kind) {
    case "document":
      return (
        <div className="prose prose-invert prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content ?? ""}</ReactMarkdown>
        </div>
      );
    case "json":
      return (
        <pre className="overflow-x-auto rounded bg-secondary p-3 text-xs leading-relaxed">
          {JSON.stringify(artifact.data ?? {}, null, 2)}
        </pre>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded bg-secondary p-3 text-xs leading-relaxed">
          {artifact.content ?? ""}
        </pre>
      );
    case "csv":
      return (
        <pre className="overflow-x-auto rounded bg-secondary p-3 text-xs leading-relaxed">
          {artifact.content ?? ""}
        </pre>
      );
    case "table":
      return <DataTable data={artifact.data} />;
    default:
      return null;
  }
}

function DataTable({ data }: { data: { columns?: string[]; rows?: (string | number | null)[][] } | null }) {
  const columns = data?.columns ?? [];
  const rows = data?.rows ?? [];
  if (columns.length === 0) return <p className="text-xs text-muted-foreground">Empty table.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} className="whitespace-nowrap border-b border-border px-2 py-1.5 font-semibold">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className={cn(ri % 2 === 1 && "bg-secondary/30")}>
              {columns.map((_, ci) => (
                <td key={ci} className="whitespace-nowrap border-b border-border/50 px-2 py-1.5">
                  {r[ci] == null ? "" : String(r[ci])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function tableToCsv(data: { columns?: string[]; rows?: (string | number | null)[][] } | null): string {
  const columns = data?.columns ?? [];
  const rows = data?.rows ?? [];
  const esc = (c: unknown) => {
    const s = c == null ? "" : String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

function extForLang(lang: string): string {
  const map: Record<string, string> = {
    typescript: "ts", javascript: "js", python: "py", bash: "sh", shell: "sh",
    yaml: "yml", markdown: "md", json: "json", sql: "sql", html: "html", css: "css",
    go: "go", rust: "rs", java: "java", ruby: "rb", php: "php",
  };
  return map[lang.toLowerCase()] ?? (lang.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "txt");
}
