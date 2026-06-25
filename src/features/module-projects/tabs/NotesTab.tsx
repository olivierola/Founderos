import { useState } from "react";
import { Plus, Trash2, Bot, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";

interface Note {
  text: string; createdAt: string;
  author_type: "human" | "agent"; author_name: string;
}

export function NotesTab({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const notes: Note[] = (mp.metadata as any)?.notes ?? [];
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState("");

  async function save(next: Note[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, notes: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function addNote() {
    if (!draft.trim()) return;
    save([{ text: draft.trim(), createdAt: new Date().toISOString(), author_type: "human", author_name: "You" }, ...notes]);
    setDraft("");
    setDrafting(false);
  }

  function removeNote(idx: number) { save(notes.filter((_, i) => i !== idx)); }

  return (
    <div className="space-y-4 py-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Notes</h3>
        <Button size="sm" variant="outline" onClick={() => setDrafting(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add note
        </Button>
      </div>

      {drafting && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} autoFocus
            placeholder="Write a note…"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setDrafting(false); setDraft(""); }}>Cancel</Button>
            <Button size="sm" onClick={addNote} disabled={!draft.trim()}>Save</Button>
          </div>
        </div>
      )}

      {notes.length === 0 && !drafting && (
        <p className="py-8 text-center text-sm text-muted-foreground">No notes yet. Humans and agents can leave notes here.</p>
      )}

      <div className="space-y-2">
        {notes.map((n, i) => (
          <div key={i} className="group rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="whitespace-pre-wrap text-sm text-foreground/90">{n.text}</p>
              <button onClick={() => removeNote(i)} className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              {n.author_type === "agent" ? <Bot className="h-3 w-3" /> : <User className="h-3 w-3" />}
              <span>{n.author_name}</span>
              <span>·</span>
              <span>{new Date(n.createdAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
