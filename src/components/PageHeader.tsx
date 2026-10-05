import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  /** Optional ending set in the serif italic, as on the site ("Agents" + "at work"). */
  accent?: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, accent, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-[26px] font-medium leading-[1.08] tracking-[-0.04em]">
          {title}
          {accent && <span className="serif-accent ml-2">{accent}</span>}
        </h1>
        {description && <p className="mt-1.5 max-w-[72ch] text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
