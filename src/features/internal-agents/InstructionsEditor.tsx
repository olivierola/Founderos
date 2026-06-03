import { useState, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Save, Check, Plus, Trash2, ChevronUp, ChevronDown,
  GripVertical, Eye, Pencil, Sparkles,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  type InternalAgent, type InstructionBlock, type InstructionBlockKind,
  INSTRUCTION_BLOCK_META, renderInstructionBlocks, newInstructionBlock,
} from "./shared";

const BLOCK_ORDER: InstructionBlockKind[] = [
  "role", "context", "tone", "steps", "constraints", "output_format", "custom",
];

// A few starter templates so non-prompt-engineers get a useful skeleton.
const TEMPLATES: Array<{ name: string; emoji: string; blocks: InstructionBlockKind[] }> = [
  { name: "Analyst", emoji: "📊", blocks: ["role", "context", "steps", "output_format"] },
  { name: "Writer", emoji: "✍️", blocks: ["role", "tone", "constraints", "output_format"] },
  { name: "Researcher", emoji: "🔍", blocks: ["role", "steps", "constraints", "output_format"] },
  { name: "Operator", emoji: "⚙️", blocks: ["role", "context", "steps", "constraints"] },
];

export function InstructionsEditor({ agent }: { agent: InternalAgent }) {
  const queryClient = useQueryClient();
  const [persona, setPersona] = useState(agent.persona ?? "");
  const [blocks, setBlocks] = useState<InstructionBlock[]>(() =>
    seedBlocks(agent),
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [preview, setPreview] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    setPersona(agent.persona ?? "");
    setBlocks(seedBlocks(agent));
  }, [agent.id]);

  const rendered = useMemo(() => renderInstructionBlocks(blocks), [blocks]);
  const charCount = rendered.length;

  function update(id: string, patch: Partial<InstructionBlock>) {
    setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }
  function move(id: string, dir: -1 | 1) {
    setBlocks((bs) => {
      const i = bs.findIndex((b) => b.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= bs.length) return bs;
      const next = [...bs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function remove(id: string) {
    setBlocks((bs) => bs.filter((b) => b.id !== id));
  }
  function addBlock(kind: InstructionBlockKind) {
    setBlocks((bs) => [...bs, newInstructionBlock(kind)]);
    setAddOpen(false);
  }
  function applyTemplate(kinds: InstructionBlockKind[]) {
    setBlocks(kinds.map(newInstructionBlock));
  }

  async function save() {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("internal_agents")
        .update({
          persona,
          instruction_blocks: blocks,
          // Mirror a rendered version into `instructions` so the worker keeps working.
          instructions: renderInstructionBlocks(blocks),
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
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Instructions</CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Compose the agent's behaviour as sections. They're combined into the system prompt.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {savedAt && Date.now() - savedAt < 4000 && (
                <span className="text-xs text-muted-foreground">
                  <Check className="mr-1 inline h-3 w-3" /> Saved
                </span>
              )}
              <Button size="sm" variant="outline" onClick={() => setPreview((p) => !p)}>
                {preview ? <Pencil className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                <span className="ml-1">{preview ? "Edit" : "Preview"}</span>
              </Button>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                <span className="ml-1">Save</span>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Persona (one line)</label>
            <Input
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              placeholder="e.g. Senior product analyst"
            />
          </div>

          {preview ? (
            <div className="rounded-md border border-border bg-muted/20 p-4">
              {rendered.trim() ? (
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{rendered}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-center text-xs text-muted-foreground">Nothing to preview yet.</p>
              )}
            </div>
          ) : blocks.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center">
              <Sparkles className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
              <p className="mb-3 text-sm text-muted-foreground">Start from a template or add a section.</p>
              <div className="flex flex-wrap justify-center gap-2">
                {TEMPLATES.map((t) => (
                  <Button key={t.name} size="sm" variant="outline" onClick={() => applyTemplate(t.blocks)}>
                    <span className="mr-1">{t.emoji}</span> {t.name}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {blocks.map((b, i) => (
                <BlockEditor
                  key={b.id}
                  block={b}
                  isFirst={i === 0}
                  isLast={i === blocks.length - 1}
                  onChange={(patch) => update(b.id, patch)}
                  onMove={(dir) => move(b.id, dir)}
                  onRemove={() => remove(b.id)}
                />
              ))}
            </div>
          )}

          {!preview && (
            <div className="flex items-center justify-between">
              <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add section
              </Button>
              <span className="text-[11px] text-muted-foreground">{charCount.toLocaleString()} chars in prompt</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add a section</DialogTitle></DialogHeader>
          <div className="grid grid-cols-1 gap-2">
            {BLOCK_ORDER.map((kind) => {
              const meta = INSTRUCTION_BLOCK_META[kind];
              return (
                <button
                  key={kind}
                  onClick={() => addBlock(kind)}
                  className="flex items-start gap-3 rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/40"
                >
                  <span className="text-base">{meta.emoji}</span>
                  <div>
                    <div className="text-sm font-medium">{meta.label}</div>
                    {meta.placeholder && (
                      <div className="line-clamp-1 text-xs text-muted-foreground">{meta.placeholder}</div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BlockEditor({
  block, isFirst, isLast, onChange, onMove, onRemove,
}: {
  block: InstructionBlock;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<InstructionBlock>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const meta = INSTRUCTION_BLOCK_META[block.kind];
  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-base">{meta.emoji}</span>
        <Input
          value={block.title}
          onChange={(e) => onChange({ title: e.target.value })}
          className="h-7 flex-1 border-0 px-1 text-sm font-medium focus-visible:ring-0"
        />
        <Badge variant="outline" className="text-[10px]">{meta.label}</Badge>
        <div className="flex items-center">
          <button
            disabled={isFirst}
            onClick={() => onMove(-1)}
            className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            disabled={isLast}
            onClick={() => onMove(1)}
            className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button onClick={onRemove} className="rounded p-1 text-destructive hover:bg-destructive/10">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <textarea
        value={block.body}
        onChange={(e) => onChange({ body: e.target.value })}
        rows={4}
        placeholder={meta.placeholder}
        className={cn(
          "w-full resize-y rounded-b-md bg-background px-3 py-2 text-sm",
          "focus:outline-none focus:ring-1 focus:ring-ring",
        )}
      />
    </div>
  );
}

// Build the initial block list: use stored blocks if present; otherwise migrate
// a legacy free-form `instructions` string into a single custom block.
function seedBlocks(agent: InternalAgent): InstructionBlock[] {
  if (agent.instruction_blocks && agent.instruction_blocks.length > 0) {
    return agent.instruction_blocks;
  }
  if (agent.instructions?.trim()) {
    return [
      {
        id: crypto.randomUUID(),
        kind: "custom",
        title: "Instructions",
        body: agent.instructions,
      },
    ];
  }
  return [];
}
