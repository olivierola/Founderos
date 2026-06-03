import { Loader2 } from "lucide-react";

/** Props every module widget receives when rendered inside a custom dashboard. */
export interface ModuleWidgetProps {
  workspaceId: string;
  projectId: string;
  /** Bumped by the dashboard to force a refetch. */
  refreshKey?: number;
}

export function WidgetLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
    </div>
  );
}

export function WidgetEmpty({ message = "No data yet." }: { message?: string }) {
  return (
    <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
      {message}
    </div>
  );
}

/** A titled section inside a grid cell — mirrors the Card/CardHeader/CardTitle look
 *  used across module pages, but without an extra Card wrapper (the grid already
 *  wraps each widget in a Card). */
export function WidgetSection({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      {title && <div className="mb-2 text-sm font-semibold">{title}</div>}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
