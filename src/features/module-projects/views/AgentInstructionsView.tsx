import { useState } from "react";
import { Save, FileEdit, Bot, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";

interface AgentConfig {
  persona: string;
  system_prompt: string;
  model: string;
  temperature: number;
  tools: Array<{ name: string; enabled: boolean }>;
  guardrails: string[];
}

const DEFAULT_CONFIG: AgentConfig = {
  persona: "",
  system_prompt: "",
  model: "deepseek-chat",
  temperature: 0.7,
  tools: [],
  guardrails: [],
};

export function AgentInstructionsView({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const config: AgentConfig = { ...DEFAULT_CONFIG, ...((mp.metadata as any)?.agent_config ?? {}) };
  const [draft, setDraft] = useState(config);
  const [dirty, setDirty] = useState(false);
  const [newTool, setNewTool] = useState("");
  const [newGuardrail, setNewGuardrail] = useState("");

  function update(patch: Partial<AgentConfig>) {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  }

  async function save() {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, agent_config: draft } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
    setDirty(false);
  }

  function addTool() {
    if (!newTool.trim()) return;
    update({ tools: [...draft.tools, { name: newTool.trim(), enabled: true }] });
    setNewTool("");
  }

  function addGuardrail() {
    if (!newGuardrail.trim()) return;
    update({ guardrails: [...draft.guardrails, newGuardrail.trim()] });
    setNewGuardrail("");
  }

  return (
    <div className="space-y-6 py-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><FileEdit className="h-4 w-4 text-muted-foreground" /> Agent Instructions</h3>
        <Button size="sm" onClick={save} disabled={!dirty}>
          <Save className="mr-1 h-3.5 w-3.5" /> Save
        </Button>
      </div>

      {/* Persona */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Persona / Role</label>
        <Input value={draft.persona} onChange={(e) => update({ persona: e.target.value })}
          placeholder="e.g. You are a senior security analyst specializing in…" />
      </div>

      {/* System prompt */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">System Prompt</label>
        <textarea value={draft.system_prompt} onChange={(e) => update({ system_prompt: e.target.value })} rows={8}
          placeholder="Detailed instructions for the agent: what it should do, how it should behave, what to avoid…"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring" />
      </div>

      {/* Model + temperature */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Model</label>
          <select value={draft.model} onChange={(e) => update({ model: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm">
            <option value="deepseek-chat">DeepSeek Chat</option>
            <option value="groq-llama-70b">Groq Llama 70B</option>
            <option value="claude-sonnet">Claude Sonnet</option>
            <option value="gpt-4o">GPT-4o</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Temperature ({draft.temperature})</label>
          <input type="range" min="0" max="1" step="0.1" value={draft.temperature}
            onChange={(e) => update({ temperature: parseFloat(e.target.value) })}
            className="w-full accent-primary" />
        </div>
      </div>

      {/* Tools */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Tools</label>
        <div className="space-y-1">
          {draft.tools.map((t, i) => (
            <div key={i} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
              <input type="checkbox" checked={t.enabled} onChange={() => {
                const next = [...draft.tools]; next[i] = { ...t, enabled: !t.enabled }; update({ tools: next });
              }} className="accent-primary" />
              <span className="flex-1 text-sm">{t.name}</span>
              <button onClick={() => update({ tools: draft.tools.filter((_, j) => j !== i) })} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Input value={newTool} onChange={(e) => setNewTool(e.target.value)} placeholder="Tool name (e.g. web_search)" className="h-7 text-xs"
            onKeyDown={(e) => { if (e.key === "Enter") addTool(); }} />
          <Button size="sm" className="h-7 text-xs" onClick={addTool} disabled={!newTool.trim()}><Plus className="h-3 w-3" /></Button>
        </div>
      </div>

      {/* Guardrails */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Guardrails</label>
        <div className="space-y-1">
          {draft.guardrails.map((g, i) => (
            <div key={i} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
              <span className="flex-1 text-xs">{g}</span>
              <button onClick={() => update({ guardrails: draft.guardrails.filter((_, j) => j !== i) })} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Input value={newGuardrail} onChange={(e) => setNewGuardrail(e.target.value)} placeholder="e.g. Never share customer PII" className="h-7 text-xs"
            onKeyDown={(e) => { if (e.key === "Enter") addGuardrail(); }} />
          <Button size="sm" className="h-7 text-xs" onClick={addGuardrail} disabled={!newGuardrail.trim()}><Plus className="h-3 w-3" /></Button>
        </div>
      </div>
    </div>
  );
}
