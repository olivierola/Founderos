import { useState } from "react";
import { cn } from "@/lib/utils";
import { OrgMembersPage } from "./OrgMembers";
import { SettingsTeamPage } from "./Team";

/**
 * Admin → Membres. Two nested scopes, one page:
 *   Organisation — who is in the workspace at all (invitations live here);
 *   Projet       — which of those people can see this project.
 * Organisation comes first because it is the gate: you cannot be on a project
 * without being in the org.
 */
export function MembersPage() {
  const [scope, setScope] = useState<"org" | "project">("org");

  return (
    <div>
      <div className="mx-auto flex max-w-3xl gap-1 px-6 pt-6">
        {([["org", "Organisation"], ["project", "Projet"]] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setScope(key)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-sm transition-colors",
              scope === key ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {scope === "org" ? <OrgMembersPage /> : <SettingsTeamPage />}
    </div>
  );
}
