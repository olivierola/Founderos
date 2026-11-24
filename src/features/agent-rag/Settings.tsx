import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon, CopyIcon, CpuIcon, IdentificationCardIcon, PowerIcon, SparkleIcon,
} from "@phosphor-icons/react";
import { SoftInput, SoftRange, SoftSelect, SoftTextarea, SoftToggle } from "@/components/ui/soft-form";
import { AgentIdentity } from "@/components/AgentIdentity";
import { SwatchRow } from "@/features/internal-agents/studio-controls";
import { supabase } from "@/lib/supabase";
import type { Agent } from "./AgentBuilder";
import { PUBLIC_AGENT_MODELS } from "./Playground";
import { publicAgentAvatarUrl } from "./PublicAgentHome";
import { PaCard, PaHeader, PaPage, PaRow, PaRows, PaSaveBar } from "./ui";

const ACCENTS = [
  { value: "#7c6fd6", label: "Violet" },
  { value: "#4b5ce0", label: "Indigo" },
  { value: "#0ea5e9", label: "Ciel" },
  { value: "#10b981", label: "Émeraude" },
  { value: "#f59e0b", label: "Ambre" },
  { value: "#f43f5e", label: "Rose" },
  { value: "#18181b", label: "Encre" },
];

export function PublicSettingsTab({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const initial = useMemo(() => ({
    name: agent.name,
    description: agent.description ?? "",
    persona: agent.persona ?? "",
    instructions: agent.instructions ?? "",
    welcome_message: agent.welcome_message ?? "",
    model: agent.model,
    temperature: agent.temperature ?? 0.3,
    enabled: agent.enabled,
    onboarding_enabled: agent.onboarding_enabled,
    onboarding_copilot_enabled: agent.onboarding_copilot_enabled,
    accent_color: agent.accent_color ?? "#7c6fd6",
  }), [agent]);
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial), [initial]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  function upd<K extends keyof typeof form>(k: K, v: (typeof form)[K]) { setForm((f) => ({ ...f, [k]: v })); }

  async function save() {
    setSaving(true); setSaved(false);
    try {
      await supabase.from("rag_agents").update({ ...form, updated_at: new Date().toISOString() }).eq("id", agent.id);
      await queryClient.invalidateQueries({ queryKey: ["rag_agent", agent.id] });
      // L'onglet Onboarding n'existe que si la fonction est active.
      queryClient.invalidateQueries({ queryKey: ["rag_agent_onb_flag", agent.id] });
      setSaved(true); setTimeout(() => setSaved(false), 1600);
    } finally { setSaving(false); }
  }

  return (
    <PaPage width="narrow">
      <PaHeader title="Réglages" sub="Identité, comportement et disponibilité de l'agent" />

      <PaCard title="Identité" icon={IdentificationCardIcon}>
        <div className="mb-5 flex items-center gap-4 rounded-xl bg-muted/40 p-4">
          <AgentIdentity url={publicAgentAvatarUrl(agent)} seed={form.name || agent.name} size={56} rounded="rounded-2xl" />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold">{form.name || "Sans nom"}</div>
            <div className="truncate text-[13px] text-muted-foreground">{form.description || "Ajoutez une description courte"}</div>
          </div>
          <span className="ml-auto h-6 w-6 shrink-0 rounded-full ring-1 ring-inset ring-black/10" style={{ background: form.accent_color }} title="Couleur de marque" />
        </div>
        <PaRows>
          <PaRow label="Nom">
            <SoftInput value={form.name} onChange={(e) => upd("name", e.target.value)} />
          </PaRow>
          <PaRow label="Description" hint="Vue dans vos listes, jamais par les visiteurs">
            <SoftInput value={form.description} onChange={(e) => upd("description", e.target.value)} placeholder="Répond aux questions sur les commandes" />
          </PaRow>
          <PaRow label="Couleur de marque" hint="Accent du widget par défaut">
            <SwatchRow
              auto="#7c6fd6"
              autoTitle="Violet de l'app"
              value={form.accent_color === "#7c6fd6" ? undefined : form.accent_color}
              palette={ACCENTS.slice(1)}
              onChange={(c) => upd("accent_color", c ?? "#7c6fd6")}
            />
          </PaRow>
          <PaRow label="Clé publique">
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-xl bg-muted/50 px-3.5 py-2.5 font-mono text-[12px]">{agent.public_key}</code>
              <button
                onClick={() => { void navigator.clipboard.writeText(agent.public_key); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Copier"
              >
                {copied ? <CheckIcon className="h-4 w-4 text-emerald-500" /> : <CopyIcon className="h-4 w-4" />}
              </button>
            </div>
          </PaRow>
        </PaRows>
      </PaCard>

      <PaCard title="Comportement" icon={SparkleIcon}>
        <PaRows>
          <PaRow label="Persona" hint="Qui il est, en une phrase">
            <SoftInput value={form.persona} onChange={(e) => upd("persona", e.target.value)} placeholder="Tu es le conseiller de la boutique…" />
          </PaRow>
          <PaRow label="Message d'accueil">
            <SoftInput value={form.welcome_message} onChange={(e) => upd("welcome_message", e.target.value)} placeholder="Bonjour ! Que puis-je faire pour vous ?" />
          </PaRow>
          <PaRow label="Instructions" stacked>
            <SoftTextarea
              value={form.instructions}
              onChange={(e) => upd("instructions", e.target.value)}
              rows={10}
              className="font-mono text-[12.5px] leading-relaxed"
              placeholder={"## Rôle\n- …\n## Ton\n- …\n## Règles\n- …"}
            />
          </PaRow>
        </PaRows>
      </PaCard>

      <PaCard title="Modèle" icon={CpuIcon}>
        <PaRows>
          <PaRow label="Modèle">
            <SoftSelect value={form.model} onChange={(v) => upd("model", v)} options={PUBLIC_AGENT_MODELS} />
          </PaRow>
          <PaRow label="Créativité" hint={`${Number(form.temperature).toFixed(1).replace(".", ",")} · bas = factuel`}>
            <SoftRange min={0} max={1} step={0.1} value={form.temperature} onChange={(e) => upd("temperature", Number(e.target.value))} />
          </PaRow>
        </PaRows>
      </PaCard>

      <PaCard title="Disponibilité" icon={PowerIcon} bodyClassName="space-y-2 pt-4">
        <SoftToggle label="Widget en ligne" checked={form.enabled} onChange={(v) => upd("enabled", v)} />
        <SoftToggle label="Mode onboarding" checked={form.onboarding_enabled} onChange={(v) => upd("onboarding_enabled", v)} />
        <SoftToggle
          label="Co-pilote agentique"
          checked={form.onboarding_copilot_enabled}
          onChange={(v) => upd("onboarding_copilot_enabled", v)}
          disabled={!form.onboarding_enabled}
        />
      </PaCard>

      <PaSaveBar dirty={dirty} saving={saving} saved={saved} onSave={() => void save()} onReset={() => setForm(initial)} />
    </PaPage>
  );
}
