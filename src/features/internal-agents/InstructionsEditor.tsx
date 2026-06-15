import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, Check, Eye, Pencil } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { type InternalAgent, renderInstructionBlocks } from "./shared";

// Instructions are a single editable markdown document describing how the agent
// should behave. It sits directly on the tab container (no card/border) so it
// reads like a document. We persist the raw markdown into `instructions` (the
// field the worker uses) and clear the legacy block model.
export function InstructionsEditor({ agent }: { agent: InternalAgent }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(() => initialInstructions(agent));
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    setText(initialInstructions(agent));
  }, [agent.id]);

  async function save() {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("internal_agents")
        .update({
          instructions: text,
          // Collapse the legacy block model — instructions are now a single doc.
          instruction_blocks: [],
          updated_at: new Date().toISOString(),
        })
        .eq("id", agent.id);
      if (error) throw error;
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["internal_agent", agent.id] });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col">
      {/* Toolbar — minimal, no surrounding card. */}
      <div className="flex items-center justify-between pb-3">
        <div>
          <h2 className="text-base font-semibold">Instructions</h2>
          <p className="text-xs text-muted-foreground">
            Markdown describing how {agent.name} should behave. It's used as the agent's system prompt.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {savedAt && Date.now() - savedAt < 4000 && (
            <span className="text-xs text-muted-foreground"><Check className="mr-1 inline h-3 w-3" /> Saved</span>
          )}
          <Button size="sm" variant="ghost" onClick={() => setPreview((p) => !p)}>
            {preview ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            <span className="ml-1">{preview ? "Edit" : "Preview"}</span>
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            <span className="ml-1">Save</span>
          </Button>
        </div>
      </div>

      {/* Editor / preview — borderless, flush with the container background. */}
      {preview ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {text.trim() ? (
            <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold prose-a:text-primary">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-center text-xs text-muted-foreground">Nothing to preview yet.</p>
          )}
        </div>
      ) : (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          className={cn(
            "min-h-0 flex-1 w-full resize-none bg-transparent font-mono text-sm leading-relaxed text-foreground",
            "border-0 p-0 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-0",
          )}
        />
      )}
    </div>
  );
}

// Prefer the stored free-form instructions; fall back to rendering any legacy
// instruction blocks into markdown so nothing is lost on first open.
function initialInstructions(agent: InternalAgent): string {
  if (agent.instructions?.trim()) return agent.instructions;
  if (agent.instruction_blocks && agent.instruction_blocks.length > 0) {
    return renderInstructionBlocks(agent.instruction_blocks);
  }
  return "";
}

const PLACEHOLDER = `# Role
You are a senior product analyst for our SaaS.

## Context
- Our ICP is B2B agencies of 5–50 people.
- Key metrics live in the Finance and Analytics modules.

## How you work
1. Always ground answers in real data — call a tool before stating numbers.
2. Be concise and actionable.
3. Ask a clarifying question when the request is ambiguous.

## Constraints
- Never take irreversible actions without explicit confirmation.
- Respect the user's access scope.`;
