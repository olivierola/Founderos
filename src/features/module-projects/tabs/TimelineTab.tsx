import { Clock } from "lucide-react";
import type { ModuleProject } from "../moduleProjectModel";

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function TimelineTab({ moduleProject }: { moduleProject: ModuleProject }) {
  const events = [
    { label: "Created", date: moduleProject.created_at },
    ...(moduleProject.updated_at !== moduleProject.created_at ? [{ label: "Updated", date: moduleProject.updated_at }] : []),
    ...(moduleProject.start_date ? [{ label: "Start date", date: moduleProject.start_date }] : []),
    ...(moduleProject.due_date ? [{ label: "Due date", date: moduleProject.due_date }] : []),
  ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return (
    <div className="py-6">
      <div className="space-y-4">
        {events.map((e, i) => (
          <div key={i} className="flex items-start gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-secondary">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="flex flex-1 items-center justify-between pt-1">
              <span className="text-sm font-medium">{e.label}</span>
              <span className="text-xs text-muted-foreground">{fmtDate(e.date)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
