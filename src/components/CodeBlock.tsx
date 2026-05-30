import { useState } from "react";
import { Copy, Check } from "lucide-react";

interface Props {
  code: string;
  language?: string;
  className?: string;
}

export function CodeBlock({ code, language, className }: Props) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }
  return (
    <div className={"relative " + (className ?? "")}>
      <pre className="overflow-x-auto rounded-md border border-border bg-secondary p-3 text-[11px] leading-relaxed">
        {code}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-2 inline-flex h-7 items-center gap-1 rounded border border-border bg-card px-2 text-[10px] text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="h-3 w-3 text-[hsl(var(--accent-2))]" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied" : "Copy"}
        {language && <span className="ml-1 opacity-60">{language}</span>}
      </button>
    </div>
  );
}
