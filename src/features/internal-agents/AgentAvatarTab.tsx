import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowCounterClockwise, CheckIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ToastProvider";
import { AvatarPicker } from "./AvatarPicker";
import type { InternalAgent } from "./shared";

// The agent's Avatar tab: the studio as a page of its own. It was a field in
// the middle of the general settings, squeezed into a box that scrolled inside
// a page that scrolled; the avatar is the agent's face everywhere it appears,
// and it deserves the room.
//
// It saves on its own — avatar_url and nothing else — so it never races the
// general form, which no longer writes the avatar.

export function AgentAvatarTab({ agent }: { agent: InternalAgent }) {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isOwner = user?.id === agent.created_by;
  const [value, setValue] = useState<string | null>(agent.avatar_url);
  const [saved, setSaved] = useState<string | null>(agent.avatar_url);
  const [saving, setSaving] = useState(false);
  const dirty = (value ?? "") !== (saved ?? "");

  async function save() {
    setSaving(true);
    const next = value || null;
    const { error } = await supabase
      .from("internal_agents")
      .update({ avatar_url: next, avatar_style: "avatar", updated_at: new Date().toISOString() })
      .eq("id", agent.id);
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setSaved(next);
    toast.success("Avatar enregistré");
    // Every surface that draws this agent reads one of these.
    for (const key of [["sd_agent_full", agent.id], ["internal_agent", agent.id], ["sd_agents"], ["sd_reporter"], ["internal_agents"]]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl">
      <header className="mb-5">
        <h2 className="text-2xl font-semibold tracking-tight">Avatar</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Le visage de {agent.name} partout dans l'app : la liste, le chat, les cartes, les salles. Un robot animé
          ou un humain en 3D, à composer trait par trait — ou à partir d'un modèle.
        </p>
        {!isOwner && (
          <p className="mt-3 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            Seule la personne qui a créé ce collaborateur peut enregistrer son avatar. Vous pouvez essayer des
            combinaisons, elles ne seront pas gardées.
          </p>
        )}
      </header>

      <AvatarPicker variant="page" value={value} onChange={setValue} accentColor={agent.accent_color} name={agent.name} />

      {/* The save bar follows the page while there is something to save. */}
      <div
        className={cn(
          "sticky bottom-4 z-20 mt-4 flex justify-center transition-all duration-300",
          dirty ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0",
        )}
      >
        <div className="flex items-center gap-3 rounded-full border border-border bg-background/90 py-1.5 pl-4 pr-1.5 shadow-lg backdrop-blur">
          <span className="text-xs text-muted-foreground">Modifications non enregistrées</span>
          <button
            type="button"
            onClick={() => setValue(saved)}
            className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowCounterClockwise className="h-3.5 w-3.5" /> Annuler
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !isOwner}
            className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <CircleNotchIcon className="h-3.5 w-3.5 animate-spin" /> : <CheckIcon className="h-3.5 w-3.5" />}
            Enregistrer
          </button>
        </div>
      </div>
    </div>
  );
}
