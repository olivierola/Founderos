import { useMemo, useState } from "react";
import { FlaskConical, Play, Loader2, ThumbsUp, Clock, Hash, Coins } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Pill, Select } from "../ui";
import { modelById } from "./data";
import { useServersDb, useFtVersionsDb, useFtEvalsDb, useFtEndpointsDb } from "./db";
import { useProvidersDb, useInfraActions } from "./infra";

const PRESETS = [
  "Réponds à ce client mécontent d'un retard de livraison",
  "Résume ce ticket support en 2 phrases",
  "Rédige un email de relance pour une facture impayée",
  "Qualifie ce lead : budget 50k€, décision Q3, secteur retail",
];

// Contenders available for comparison beside the fine-tuned model.
const CONTENDERS = [
  { id: "base", label: "Modèle de base", kind: "base" as const },
  { id: "gpt-5.2", label: "GPT-5.2", kind: "cloud" as const },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", kind: "cloud" as const },
  { id: "mistral-large-3", label: "Mistral Large 3", kind: "cloud" as const },
  { id: "llama-4-maverick", label: "Llama 4", kind: "self" as const },
];

// Simulated responses per style — the tuned model knows the brand voice/context.
function simulate(prompt: string, style: "tuned" | "base" | "gpt" | "claude" | "llama" | "mistral"): string {
  const p = prompt.toLowerCase();
  const topic = p.includes("retard") || p.includes("mécontent") ? "retard" : p.includes("résume") ? "resume" : p.includes("facture") ? "facture" : "lead";
  const T: Record<string, Record<string, string>> = {
    retard: {
      tuned: "Bonjour Camille, vous avez raison d'être déçue — votre commande aurait dû arriver mardi. Elle est partie ce matin (suivi FR-2847) et arrivera avant vendredi. La livraison est offerte. — L'équipe",
      base: "Bonjour, nous nous excusons pour le retard. Votre commande est en cours de traitement et sera livrée dès que possible. Cordialement.",
      gpt: "Bonjour, merci de nous avoir contactés. Nous comprenons votre frustration concernant ce retard. Votre commande est prioritaire et nous reviendrons vers vous avec un numéro de suivi sous 24h.",
      claude: "Bonjour, je comprends parfaitement votre frustration face à ce retard — c'est une situation pénible. Votre commande a été localisée et expédiée ; vous recevrez le suivi par email d'ici ce soir. Puis-je faire autre chose pour vous ?",
      llama: "Bonjour, désolé pour le retard de votre commande. Elle devrait arriver bientôt. Merci de votre patience.",
    },
    resume: {
      tuned: "Client Pro (plan Scale) bloqué par l'export CSV depuis la v2.4 — erreur 500 sur gros volumes. Contournement : export par lots ; correctif au prochain déploiement.",
      base: "Le client rencontre un problème avec le produit et demande de l'aide. Le support doit examiner la demande.",
      gpt: "Un client signale une erreur lors de l'export de données volumineuses. L'équipe technique propose une solution temporaire en attendant un correctif.",
      claude: "Résumé : un client Pro rencontre une erreur 500 à l'export CSV sur les volumes importants depuis la mise à jour 2.4. Un contournement par lots est proposé, correctif planifié.",
      llama: "Le client a un problème d'export CSV qui donne une erreur. Le support propose une solution de contournement.",
    },
    facture: {
      tuned: "Bonjour Marc, petit rappel amical : la facture #1024 (3 450 €, échue le 12/06) reste ouverte. Lien de paiement joint — si un point bloque, appelez-moi et on règle ça ensemble. Bonne journée !",
      base: "Bonjour, sauf erreur de notre part, la facture mentionnée reste impayée. Merci de procéder au règlement. Cordialement.",
      gpt: "Objet : Rappel de paiement — Bonjour, nous vous rappelons que votre facture demeure impayée à ce jour. Nous vous remercions de bien vouloir régulariser la situation dans les meilleurs délais.",
      claude: "Bonjour Marc, j'espère que vous allez bien. Je me permets de revenir vers vous au sujet de la facture #1024 arrivée à échéance. Si le règlement est déjà en cours, ignorez ce message ; sinon, le lien de paiement est ci-dessous. Belle journée !",
      llama: "Bonjour, votre facture n'a pas été payée. Merci de payer rapidement. Cordialement.",
    },
    lead: {
      tuned: "Lead qualifié : ICP ✅ (retail, budget 50k€ dans la fourchette), timing Q3 → cycle standard. Score 82/100. Prochaine étape : démo multi-magasins, inviter le DAF.",
      base: "Ce lead semble intéressant. Il faudrait le contacter pour en savoir plus sur ses besoins.",
      gpt: "Ce prospect présente un profil pertinent : budget défini, échéance claire au Q3 et secteur d'activité ciblé. Recommandation : qualification approfondie par un commercial senior.",
      claude: "Analyse du lead : budget 50k€ (aligné avec l'offre Scale), décision Q3 (cycle de 8-10 semaines, timing correct), retail (vertical prioritaire). Score estimé : élevé. Suggestion : proposer une démo orientée cas d'usage retail.",
      llama: "Le lead a un budget de 50k€ et veut décider au Q3. C'est un bon prospect du secteur retail à contacter.",
    },
  };
  const m = T[topic];
  if (style === "mistral") return m.gpt.replace("Objet : ", "").slice(0, 180) + "…";
  return style === "tuned" ? m.tuned : style === "base" ? m.base : style === "gpt" ? m.gpt : style === "claude" ? m.claude : m.llama;
}

interface RunResult { id: string; label: string; text: string; ms: number; tokens: number; cost: number; tuned?: boolean; real?: boolean }

export function GovFtPromptTestsPage() {
  const { servers } = useServersDb();
  const { versions: allVersions } = useFtVersionsDb(servers);
  const { recordVote } = useFtEvalsDb(servers);
  const { cloudProviders } = useProvidersDb();
  const infra = useInfraActions();
  const versions = useMemo(() => allVersions.filter((v) => v.status !== "archived"), [allVersions]);
  const { endpoints } = useFtEndpointsDb(servers, allVersions);

  const [versionId, setVersionId] = useState<string>("");
  const [contenders, setContenders] = useState<Set<string>>(() => new Set(["base"]));
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(0.95);
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RunResult[] | null>(null);
  const [vote, setVote] = useState<string | null>(null);

  const current = versions.find((v) => v.id === versionId) ?? versions[0];

  // A live deployment of the selected version on a rented pod (endpoint_url)
  // lets the "tuned" column run REAL inference instead of the simulation.
  const tunedServer = useMemo(() => {
    if (!current) return null;
    const ep = endpoints.find((e) => e.status === "active" && e.versionName === current.name && e.version === current.version);
    const srv = ep ? servers.find((s) => s.id === ep.serverId) : undefined;
    return srv?.endpointUrl ? srv : null;
  }, [endpoints, servers, current]);

  const toggleContender = (id: string) =>
    setContenders((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const run = async (p: string) => {
    if (!p.trim() || running || !current) return;
    setRunning(true); setVote(null);
    const out: RunResult[] = [];
    const mk = (id: string, label: string, style: Parameters<typeof simulate>[1], msLo: number, msHi: number, costMult: number, tuned = false) => {
      const text = simulate(p, style);
      const tokens = Math.round(text.length / 3.4);
      const ms = Math.round(msLo + Math.random() * (msHi - msLo));
      out.push({ id, label, text, ms, tokens, cost: Math.round(tokens * costMult) / 100000, tuned });
    };
    if (tunedServer) {
      try {
        const res = await infra.chat({ serverId: tunedServer.id, messages: [{ role: "user", content: p }], temperature, topP, maxTokens: 400 });
        out.push({ id: "tuned", label: `${current.name} ${current.version} (affiné)`, text: res.content || "(réponse vide)", ms: res.ms, tokens: res.tokensOut || Math.round((res.content?.length ?? 0) / 3.4), cost: 0, tuned: true, real: true });
      } catch (e) {
        out.push({ id: "tuned", label: `${current.name} ${current.version} (affiné)`, text: `⚠️ ${e instanceof Error ? e.message : "erreur d'inférence"}`, ms: 0, tokens: 0, cost: 0, tuned: true, real: true });
      }
    } else {
      mk("tuned", `${current.name} ${current.version} (affiné)`, "tuned", 220, 520, 4, true);
    }
    if (contenders.has("base")) mk("base", `${modelById(current.baseModel)?.label ?? current.baseModel} (base)`, "base", 350, 800, 6);
    if (contenders.has("gpt-5.2")) mk("gpt-5.2", "GPT-5.2", "gpt", 700, 1600, 160);
    if (contenders.has("claude-sonnet-5")) mk("claude-sonnet-5", "Claude Sonnet 5", "claude", 600, 1400, 150);
    if (contenders.has("mistral-large-3")) mk("mistral-large-3", "Mistral Large 3", "mistral", 500, 1100, 60);
    if (contenders.has("llama-4-maverick")) mk("llama-4-maverick", "Llama 4 Maverick", "llama", 300, 700, 8);

    // REAL inference through any connected cloud endpoint that the user selected.
    await Promise.all(cloudProviders.filter((cp) => contenders.has(`prov:${cp.id}`)).map(async (cp) => {
      const model = cp.metadata.models?.[0] ?? "default";
      try {
        const res = await infra.chat({ providerId: cp.id, model, messages: [{ role: "user", content: p }], temperature, topP, maxTokens: 400 });
        out.push({ id: `prov:${cp.id}`, label: `${cp.name} · ${model}`, text: res.content || "(réponse vide)", ms: res.ms, tokens: res.tokensOut || Math.round((res.content?.length ?? 0) / 3.4), cost: 0, real: true });
      } catch (e) {
        out.push({ id: `prov:${cp.id}`, label: cp.name, text: `⚠️ ${e instanceof Error ? e.message : "erreur d'inférence"}`, ms: 0, tokens: 0, cost: 0, real: true });
      }
    }));
    setResults([...out]); setRunning(false);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Prompt Tests"
        description="Testez le modèle affiné sur vos prompts et comparez-le au modèle de base, GPT, Claude ou Llama. Le modèle affiné répond en réel dès qu'il est déployé sur un pod (onglet Déploiement) ; les concurrents statiques sont simulés — branchez un fournisseur cloud (AI Ops → Modèles) pour des comparaisons réelles."
      />

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Modèle affiné :</span>
          <Select value={current?.id ?? ""} onChange={(e) => setVersionId(e.target.value)} className="h-9 w-64">
            {versions.map((v) => <option key={v.id} value={v.id}>{v.name} {v.version}</option>)}
          </Select>
          <Pill meta={tunedServer ? { label: "endpoint live", tone: "emerald" } : { label: "non déployé — simulation", tone: "slate" }} className="px-1.5 py-0 text-[10px]" />
          <span className="ml-2 text-xs text-muted-foreground">Comparer à :</span>
          {CONTENDERS.map((c) => (
            <button
              key={c.id}
              onClick={() => toggleContender(c.id)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                contenders.has(c.id)
                  ? "border-[hsl(var(--accent-teal)/0.5)] bg-[hsl(var(--accent-teal)/0.12)] text-foreground"
                  : "border-border bg-secondary/40 text-muted-foreground hover:text-foreground",
              )}
            >
              {c.label}
            </button>
          ))}
          {/* Connected cloud endpoints → real inference contenders. */}
          {cloudProviders.map((cp) => (
            <button
              key={cp.id}
              onClick={() => toggleContender(`prov:${cp.id}`)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                contenders.has(`prov:${cp.id}`)
                  ? "border-emerald-500/50 bg-emerald-500/12 text-foreground"
                  : "border-border bg-secondary/40 text-muted-foreground hover:text-foreground",
              )}
            >
              {cp.name} <Pill meta={{ label: "réel", tone: "emerald" }} className="px-1 py-0 text-[9px]" />
            </button>
          ))}
        </div>

        {/* Paramètres d'inférence */}
        <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-border/60 pt-3 text-xs">
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Temperature</span>
            <input type="range" min={0} max={1} step={0.05} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} className="w-28 accent-[hsl(var(--accent-teal))]" />
            <span className="w-8 tabular-nums">{temperature.toFixed(2)}</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Top P</span>
            <input type="range" min={0} max={1} step={0.05} value={topP} onChange={(e) => setTopP(Number(e.target.value))} className="w-28 accent-[hsl(var(--accent-teal))]" />
            <span className="w-8 tabular-nums">{topP.toFixed(2)}</span>
          </label>
        </div>

        <div className="mt-3">
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Écrivez un prompt à tester…" className="min-h-[80px]" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => (
              <button key={p} onClick={() => { setPrompt(p); run(p); }}
                className="rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
                {p}
              </button>
            ))}
            <Button size="sm" className="ml-auto" disabled={!prompt.trim() || running} onClick={() => run(prompt)}>
              {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}Tester
            </Button>
          </div>
        </div>
      </Card>

      {results && (
        <div className={cn("grid gap-4", results.length <= 2 ? "lg:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-3")}>
          {results.map((res) => (
            <Card key={res.id} className={cn("flex flex-col p-4", res.tuned && "border-[hsl(var(--accent-teal)/0.45)]")}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className={cn("flex min-w-0 items-center gap-1.5 text-xs font-medium", res.tuned ? "text-[hsl(var(--accent-teal))]" : "text-muted-foreground")}>
                  <span className="truncate">{res.label}</span>
                  <Pill meta={res.real ? { label: "réel", tone: "emerald" } : { label: "simulé", tone: "slate" }} className="shrink-0 px-1.5 py-0 text-[9px]" />
                </span>
                <button onClick={() => { setVote(res.id); if (current) recordVote(current.jobName, res.id === "tuned"); }} className={cn("rounded-md p-1.5 transition-colors", vote === res.id ? "bg-emerald-500/15 text-emerald-500" : "text-muted-foreground hover:bg-secondary")} aria-label={`Préférer ${res.label}`}>
                  <ThumbsUp className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className={cn("flex-1 text-[13px] leading-relaxed", !res.tuned && "text-muted-foreground")}>{res.text}</p>
              <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{res.ms} ms</span>
                <span className="inline-flex items-center gap-1"><Hash className="h-3 w-3" />{res.tokens} tok</span>
                <span className="inline-flex items-center gap-1"><Coins className="h-3 w-3" />${res.cost.toFixed(5)}</span>
                <span>T° {temperature.toFixed(2)}</span>
                <span>topP {topP.toFixed(2)}</span>
              </div>
            </Card>
          ))}
        </div>
      )}

      {results && vote && (
        <p className="text-xs text-muted-foreground">
          Préférence enregistrée — ces votes alimentent le win-rate de l'onglet Évaluation.
        </p>
      )}

      {!results && (
        <Card className="flex items-center gap-3 border-dashed p-4 text-sm text-muted-foreground">
          <FlaskConical className="h-4 w-4" /> Choisissez les modèles à comparer, un prompt préréglé ou le vôtre, puis « Tester ».
        </Card>
      )}
    </div>
  );
}
