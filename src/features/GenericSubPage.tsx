import { useParams } from "react-router-dom";
import { Construction } from "lucide-react";
import { findModule } from "@/lib/navigation";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";

interface GenericSubPageProps {
  moduleSlug: string;
  subSlug: string;
}

export function GenericSubPage({ moduleSlug, subSlug }: GenericSubPageProps) {
  const params = useParams();
  const module = findModule(moduleSlug);
  const sub = module?.subItems.find((s) => s.slug === subSlug);

  const title = sub?.label ?? subSlug;
  const moduleLabel = module?.label ?? moduleSlug;

  return (
    <div>
      <PageHeader
        title={title}
        description={`${moduleLabel} · ${params.projectSlug ?? "project"}`}
      />
      <EmptyState
        icon={Construction}
        title="Coming soon"
        description={`The ${title} view is part of the upcoming sprints. Data sources and widgets defined in the technical spec will be wired here.`}
      />
    </div>
  );
}
