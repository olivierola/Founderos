import { useNavigate, useParams } from "react-router-dom";
import { Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { findProvider } from "@/lib/providers";
import { cn } from "@/lib/utils";

interface ServiceBadgeProps {
  service: string;
  category?: string;
  className?: string;
}

/**
 * A detected service/dependency. If it maps to a known provider in the catalog,
 * it becomes clickable and deep-links to Integrations → Catalog with the config
 * modal pre-opened so the user can add a token/key and start pulling data.
 */
export function ServiceBadge({ service, category, className }: ServiceBadgeProps) {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const provider = findProvider(service.toLowerCase());

  const label = category ? `${service} · ${category}` : service;

  if (!provider) {
    return (
      <Badge variant="secondary" className={className}>
        {label}
      </Badge>
    );
  }

  return (
    <button
      onClick={() =>
        navigate(`/app/${workspaceSlug}/${projectSlug}/integrations/catalog?connect=${provider.slug}`)
      }
      title={`Configure ${provider.name}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20",
        className,
      )}
    >
      {label}
      <Settings2 className="h-3 w-3" />
    </button>
  );
}
