import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <Card className="flex flex-col items-center justify-center gap-3 p-10 text-center">
      {Icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-md bg-secondary text-muted-foreground">
          <Icon className="h-6 w-6" />
        </div>
      )}
      <div className="text-base font-semibold">{title}</div>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </Card>
  );
}
