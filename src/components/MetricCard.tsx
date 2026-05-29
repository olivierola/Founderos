import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface MetricCardProps {
  label: string;
  value: string;
  delta?: string;
  hint?: string;
  icon?: LucideIcon;
  trend?: "up" | "down" | "flat";
}

export function MetricCard({ label, value, delta, hint, icon: Icon, trend = "flat" }: MetricCardProps) {
  const trendColor =
    trend === "up" ? "text-emerald-400" : trend === "down" ? "text-red-400" : "text-muted-foreground";
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{label}</span>
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
        </div>
        <div className="mt-3 text-2xl font-semibold tracking-tight">{value}</div>
        {delta && <div className={`mt-1 text-xs ${trendColor}`}>{delta}</div>}
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
