import { useState } from "react";
import { Download, Copy, Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { exportToCsv, exportToJson } from "@/lib/utils";

interface ExportMenuProps {
  /** Rows to export. Flat objects export cleanly to CSV; nested objects fall back to JSON cells. */
  rows: Record<string, unknown>[];
  /** Base filename without extension. */
  filename: string;
  /** Optional label override. */
  label?: string;
  size?: "sm" | "default";
}

/**
 * Reusable export control for any log / table view: copy to clipboard (JSON),
 * download CSV, or download JSON.
 */
export function ExportMenu({ rows, filename, label = "Export", size = "sm" }: ExportMenuProps) {
  const [copied, setCopied] = useState(false);
  const disabled = !rows || rows.length === 0;

  async function copyJson() {
    await navigator.clipboard.writeText(JSON.stringify(rows, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size={size} disabled={disabled}>
          {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Download className="h-4 w-4" />}
          {label}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={copyJson}>
          <Copy className="h-4 w-4" /> Copy to clipboard
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => exportToCsv(rows, `${filename}.csv`)}>
          <Download className="h-4 w-4" /> Export CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => exportToJson(rows, `${filename}.json`)}>
          <Download className="h-4 w-4" /> Export JSON
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
