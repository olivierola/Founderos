import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  PlusIcon, PackageIcon, KeyIcon, DownloadSimpleIcon, PlayIcon, PauseIcon, StopIcon, ArrowsClockwiseIcon,
  CpuIcon, GlobeIcon, CopyIcon, TrashIcon, TerminalWindowIcon, DatabaseIcon, FloppyDiskIcon, ArrowSquareOutIcon, UploadSimpleIcon,
  WarningIcon, CircleNotchIcon as Loader2,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { useToast } from "@/components/ToastProvider";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/features/tracker/pickers";
import {
  downloadBase64, embeddedApi, isLive, useEmbeddedAgents, useRefreshEmbedded,
  type EmbeddedAgent, type EmbeddedConfig, type EmbeddedList, type SeedFile,
} from "./api";
import type { MachineCatalog } from "@/features/machines/api";

/**
 * Les agents embarqués du service (0316) : la troisième sorte d'agent, à côté
 * des collaborateurs internes et des agents publics. Un agent FounderOS
 * empaqueté avec sa machine, un conteneur qui tourne où l'on veut (un serveur
 * du client, un poste près des données) et reste piloté d'ici : sa
 * configuration, ses clés, ses versions exportées, ses instances en ligne.
 */
export function EmbeddedAgentsTab({ dashboardId, base }: { dashboardId: string; base: string }) {
  const { data, isLoading } = useEmbeddedAgents(dashboardId);
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [startTools, setStartTools] = useState<string[]>([]);
  const [startPreset, setStartPreset] = useState<string | null>(null);
  // « Agent embarqué » depuis le menu des collaborateurs arrive ici avec ?new=1 ;
  // depuis le composeur de machine, avec ?tools= (et parfois ?preset=) en plus.
  useEffect(() => {
    if (params.get("new") !== "1") return;
    setStartTools((params.get("tools") ?? "").split(",").map((t) => t.trim()).filter(Boolean));
    setStartPreset(params.get("preset"));
    setCreating(true);
    const next = new URLSearchParams(params);
    next.delete("new");
    next.delete("tools");
    next.delete("preset");
    setParams(next, { replace: true });
  }, [params, setParams]);
  const agents = data?.agents ?? [];
  const selectedId = params.get("a") && agents.some((a) => a.id === params.get("a")) ? params.get("a")! : agents[0]?.id ?? null;
  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("a", id);
    setParams(next, { replace: true });
  };

  return (
    <PageShell>
      <PageHeader
        title="Agents embarqués"
        description="Un agent FounderOS empaqueté avec sa machine : un conteneur qui tourne où vous le voulez, sur un serveur du client ou près des données, et qui reste piloté d'ici."
        actions={<Button onClick={() => setCreating(true)}><PlusIcon className="mr-1.5 h-4 w-4" /> Créer un agent embarqué</Button>}
      />
      {isLoading ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
      ) : agents.length === 0 ? (
        <EmptyState onCreate={() => setCreating(true)} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <nav className="space-y-1">
            {agents.map((a) => {
              const live = (data?.instances ?? []).filter((i) => i.agent_id === a.id && isLive(i)).length;
              const last = (data?.builds ?? []).find((b) => b.agent_id === a.id);
              return (
                <button
                  key={a.id} type="button" onClick={() => select(a.id)}
                  className={cn("w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
                    a.id === selectedId ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50")}
                >
                  <div className="flex items-center gap-2">
                    <PackageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{a.name}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
                    <span className={cn("h-1.5 w-1.5 rounded-full", live ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                    {live ? `${live} instance${live > 1 ? "s" : ""} en ligne` : "aucune instance en ligne"}
                    {last && <span className="ml-auto font-mono">v{last.version}</span>}
                  </div>
                </button>
              );
            })}
          </nav>
          {selected && data && <AgentPanel key={selected.id} agent={selected} data={data} dashboardId={dashboardId} base={base} />}
        </div>
      )}
      <CreateDialog open={creating} onOpenChange={(v) => { setCreating(v); if (!v) { setStartTools([]); setStartPreset(null); } }} dashboardId={dashboardId} onCreated={select}
        catalog={data?.catalog ?? null} initialTools={startTools} initialPreset={startPreset} />
    </PageShell>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="max-w-2xl rounded-xl border border-border p-6">
      <div className="text-[15px] font-medium">Votre premier agent embarqué</div>
      <ol className="mt-3 space-y-2 text-[13px] text-muted-foreground">
        <li>1. Créez-le, puis donnez-lui ses consignes, ses pools et ses skills sur sa fiche, comme un collaborateur.</li>
        <li>2. Réglez sa machine : ressources, paquets, fichiers de départ, modèle, ce qui remonte à FounderOS.</li>
        <li>3. Exportez son conteneur et lancez-le où vous voulez avec une clé d'API, ou lancez-le ici si Docker tourne sur cet hôte.</li>
      </ol>
      <Button className="mt-4" onClick={onCreate}><PlusIcon className="mr-1.5 h-4 w-4" /> Créer un agent embarqué</Button>
    </div>
  );
}

function CreateDialog({ open, onOpenChange, dashboardId, onCreated, catalog, initialTools, initialPreset }: {
  open: boolean; onOpenChange: (v: boolean) => void; dashboardId: string; onCreated: (id: string) => void;
  catalog: MachineCatalog | null; initialTools: string[]; initialPreset: string | null;
}) {
  const toast = useToast();
  const refresh = useRefreshEmbedded(dashboardId);
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [instructions, setInstructions] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(""); setPersona(""); setInstructions("");
    const valid = new Set((catalog?.tools ?? []).map((t) => t.id));
    const preset = catalog?.presets.find((p) => p.id === initialPreset);
    setTools([...new Set([...(preset?.tools ?? []), ...initialTools])].filter((t) => valid.has(t)));
  }, [open, initialTools, initialPreset, catalog]);
  const submit = async () => {
    setSaving(true);
    try {
      const r = await embeddedApi.create(dashboardId, {
        name: name.trim(), persona: persona.trim() || undefined, instructions: instructions.trim() || undefined,
        tools: tools.length ? tools : undefined,
      });
      await refresh();
      onOpenChange(false);
      onCreated(r.agent.id);
      toast.success("Agent embarqué créé", "Réglez sa machine, puis exportez son conteneur.");
    } catch (e) {
      toast.error("Création impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Créer un agent embarqué</DialogTitle>
          <DialogDescription>Un agent FounderOS qui tournera dans son propre conteneur. Ses pools, skills et modèles se règlent ensuite sur sa fiche.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Nom"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Agent ERP du site de Lyon" /></Field>
          <Field label="Rôle"><Input value={persona} onChange={(e) => setPersona(e.target.value)} placeholder="ex. Assistant d'exploitation de l'ERP" /></Field>
          <Field label="Consignes"><Textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Ce qu'il fait, ce qu'il ne fait jamais, à qui il rend compte" /></Field>
          <Field label="Ses outils"><ToolPicker catalog={catalog} value={tools} onChange={setTools} /></Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button onClick={submit} disabled={saving || !name.trim()}>{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Créer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const splitList = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function AgentPanel({ agent, data, dashboardId, base }: { agent: EmbeddedAgent; data: EmbeddedList; dashboardId: string; base: string }) {
  const toast = useToast();
  const navigate = useNavigate();
  const refresh = useRefreshEmbedded(dashboardId);
  const config = data.configs.find((c) => c.agent_id === agent.id) ?? null;
  const builds = data.builds.filter((b) => b.agent_id === agent.id);
  const instances = data.instances.filter((i) => i.agent_id === agent.id);
  const keys = data.keys.filter((k) => k.agent_id === agent.id);
  const latest = builds[0] ?? null;

  const [draft, setDraft] = useState<EmbeddedConfig | null>(config);
  const [lists, setLists] = useState({ apt: "", pip: "", npm: "", egress: "" });
  useEffect(() => {
    setDraft(config);
    setLists({
      apt: (config?.apt_packages ?? []).join(" "), pip: (config?.pip_packages ?? []).join(" "),
      npm: (config?.npm_packages ?? []).join(" "), egress: (config?.egress ?? []).join(" "),
    });
  // Une configuration relue (rafraîchissement) ne doit pas écraser une saisie en cours : on suit l'agent.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, !!config]);
  const [busy, setBusy] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [keyLabel, setKeyLabel] = useState("");
  const [instanceName, setInstanceName] = useState("local");

  const dirty = useMemo(() => {
    if (!draft || !config) return false;
    const now = { ...draft, apt_packages: splitList(lists.apt), pip_packages: splitList(lists.pip), npm_packages: splitList(lists.npm), egress: splitList(lists.egress) };
    return JSON.stringify(now) !== JSON.stringify(config);
  }, [draft, config, lists]);

  if (!draft) return <p className="text-[13px] text-muted-foreground">Configuration introuvable.</p>;
  const set = <K extends keyof EmbeddedConfig>(k: K, v: EmbeddedConfig[K]) => setDraft({ ...draft, [k]: v });

  const act = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(name);
    try {
      await fn();
      await refresh();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error("Échec", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const save = () => act("save", () => embeddedApi.updateConfig(agent.id, {
    connectivity: draft.connectivity, llm_route: draft.llm_route, llm_base_url: draft.llm_base_url || null, llm_model: draft.llm_model || null,
    sync_level: draft.sync_level, knowledge_snapshot: draft.knowledge_snapshot, shell_enabled: draft.shell_enabled,
    cpus: Number(draft.cpus), memory_mb: Number(draft.memory_mb), disk_mb: Number(draft.disk_mb),
    apt_packages: splitList(lists.apt), pip_packages: splitList(lists.pip), npm_packages: splitList(lists.npm), egress: splitList(lists.egress),
    seed_files: draft.seed_files, runtime_version: draft.runtime_version, tools: draft.tools ?? [],
  }), "Réglages enregistrés");
  const exportZip = () => act("export", async () => {
    const r = await embeddedApi.export(agent.id);
    downloadBase64(r.filename, r.zip_base64);
  }, "Conteneur exporté");

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-semibold">{agent.name}</div>
          <p className="text-[13px] text-muted-foreground">{agent.persona || "Agent embarqué"}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate(`${base}/agent/${agent.id}`)}>
          <ArrowSquareOutIcon className="mr-1.5 h-4 w-4" /> Consignes, pools, skills
        </Button>
      </div>

      <Card title="La machine" icon={CpuIcon} hint="Le conteneur de l'agent : ses ressources, son shell, ce qu'on y installe et ce qu'on y dépose.">
        <Field label="Outils du catalogue">
          <ToolPicker catalog={data.catalog ?? null} value={draft.tools ?? []} onChange={(ids) => set("tools", ids)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Processeurs"><Input type="number" min={0.5} step={0.5} value={draft.cpus} onChange={(e) => set("cpus", Number(e.target.value))} /></Field>
          <Field label="Mémoire (Mo)"><Input type="number" min={256} step={256} value={draft.memory_mb} onChange={(e) => set("memory_mb", Number(e.target.value))} /></Field>
          <Field label="Disque (Mo)"><Input type="number" min={512} step={512} value={draft.disk_mb} onChange={(e) => set("disk_mb", Number(e.target.value))} /></Field>
        </div>
        <Toggle label="Shell dans le conteneur" desc="L'agent lance des commandes dans sa machine (scripts, outils installés). Rien hors de /workspace." checked={draft.shell_enabled} onChange={(v) => set("shell_enabled", v)} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Paquets système (apt)"><Input value={lists.apt} onChange={(e) => setLists({ ...lists, apt: e.target.value })} placeholder="ex. poppler-utils jq" /></Field>
          <Field label="Python (pip)"><Input value={lists.pip} onChange={(e) => setLists({ ...lists, pip: e.target.value })} placeholder="ex. pandas openpyxl" /></Field>
          <Field label="Node (npm)"><Input value={lists.npm} onChange={(e) => setLists({ ...lists, npm: e.target.value })} placeholder="ex. csv-parse" /></Field>
        </div>
        <SeedFiles files={draft.seed_files} onChange={(f) => set("seed_files", f)} />
      </Card>

      <Card title="Le modèle" icon={TerminalWindowIcon} hint="Par FounderOS (clés et crédits de la plateforme), ou en direct sur le point d'accès du client : ses données ne passent alors pas par FounderOS.">
        <Choice
          value={draft.llm_route} onChange={(v) => set("llm_route", v)}
          options={[
            ["founderos", "Par FounderOS", "Les modèles de l'agent, sur la connexion de la plateforme."],
            ["direct", "En direct", "Un point d'accès compatible OpenAI ; sa clé est donnée au lancement (LLM_API_KEY)."],
          ]}
        />
        {draft.llm_route === "direct" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Adresse"><Input className="font-mono text-[13px]" value={draft.llm_base_url ?? ""} onChange={(e) => set("llm_base_url", e.target.value)} placeholder="https://mon-azure.openai.azure.com/openai/v1" /></Field>
            <Field label="Modèle"><Input className="font-mono text-[13px]" value={draft.llm_model ?? ""} onChange={(e) => set("llm_model", e.target.value)} placeholder="ex. gpt-6-luna" /></Field>
          </div>
        )}
      </Card>

      <Card title="Le lien avec FounderOS" icon={GlobeIcon} hint="Ce qui passe par le réseau et ce qui remonte. Les outils de la plateforme passent toujours par sa clé d'API, dans ses pools.">
        <Field label="Connexion">
          <Choice
            value={draft.connectivity} onChange={(v) => set("connectivity", v)}
            options={[
              ["connected", "Connecté", "Tout en direct."],
              ["intermittent", "Intermittent", "Réseau instable : ses écritures attendent le retour de la liaison, sa recherche passe sur la connaissance embarquée."],
              ["isolated", "Isolé", "Aucune liaison : on lui parle sur le site, son journal s'importe ensuite ici."],
            ]}
          />
        </Field>
        {draft.connectivity === "isolated" && draft.llm_route !== "direct" && (
          <p className="text-[12px] text-destructive">En mode isolé, le modèle doit être en accès direct (carte « Le modèle »).</p>
        )}
        <Field label="Ce qui remonte des conversations">
          <Choice
            value={draft.sync_level} onChange={(v) => set("sync_level", v)}
            options={[
              ["full", "Tout", "Messages et étapes, comme un collaborateur."],
              ["summary", "Un résumé", "Les messages tronqués, les étapes."],
              ["metadata", "Statuts et coûts", "Rien du contenu : il reste sur l'instance."],
            ]}
          />
        </Field>
        <Toggle label="Connaissance embarquée" desc="Ses documents et ses mémoires copiés dans l'image et rafraîchis au démarrage, pour chercher même sans réseau." checked={draft.knowledge_snapshot} onChange={(v) => set("knowledge_snapshot", v)} icon={DatabaseIcon} />
        <Field label="Sorties réseau permises (en plus de FounderOS et du modèle)"><Input value={lists.egress} onChange={(e) => setLists({ ...lists, egress: e.target.value })} placeholder="ex. erp.client.local api.github.com" /></Field>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={!dirty || busy === "save"}>
          {busy === "save" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <FloppyDiskIcon className="mr-1.5 h-4 w-4" />} Enregistrer
        </Button>
      </div>

      <Card title="Versions et export" icon={PackageIcon} hint="Une version fige sa configuration (manifeste, sans secret). L'archive contient sa machine : Dockerfile, compose, manifeste, fichiers de départ.">
        <div className="flex flex-wrap items-end gap-2">
          <Button onClick={exportZip} disabled={busy === "export" || dirty}>
            {busy === "export" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <DownloadSimpleIcon className="mr-1.5 h-4 w-4" />} Exporter le conteneur
          </Button>
          {data.local.ok ? (
            <>
              <Input className="h-9 w-36" value={instanceName} onChange={(e) => setInstanceName(e.target.value)} aria-label="Nom de l'instance" />
              <Button variant="outline" onClick={() => act("run", () => embeddedApi.runLocal(agent.id, instanceName || "local"), "Construction lancée : l'instance apparaîtra dès qu'elle répond")} disabled={busy === "run" || dirty}>
                {busy === "run" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <PlayIcon className="mr-1.5 h-4 w-4" />} Construire et lancer ici
              </Button>
            </>
          ) : (
            <span className="text-[12px] text-muted-foreground">{data.local.reason}</span>
          )}
        </div>
        {dirty && <p className="text-[12px] text-muted-foreground">Enregistrez les réglages avant d'exporter.</p>}
        {builds.length > 0 && (
          <div className="divide-y divide-border rounded-lg border border-border">
            {builds.slice(0, 8).map((b) => (
              <div key={b.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-[13px]">
                <span className="font-mono">v{b.version}</span>
                <span className="font-mono text-[12px] text-muted-foreground">{b.manifest_sha.slice(0, 12)}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-[11px]",
                  b.status === "built" ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
                    : b.status === "failed" ? "bg-destructive/10 text-destructive"
                    : b.status === "building" ? "bg-amber-500/12 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground")}>
                  {b.status === "built" ? "image construite" : b.status === "failed" ? "échec" : b.status === "building" ? "construction…" : "exportée"}
                </span>
                <span className="ml-auto text-[12px] text-muted-foreground">{formatRelative(b.created_at)}</span>
                {b.log && <p className={cn("w-full truncate font-mono text-[11px]", b.status === "failed" ? "text-destructive" : "text-muted-foreground")} title={b.log}>{b.log}</p>}
              </div>
            ))}
          </div>
        )}
        <details className="text-[12px] text-muted-foreground">
          <summary className="cursor-pointer">Lancer l'archive ailleurs</summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted/60 p-3 font-mono text-[11.5px] text-foreground">{[
            "# depuis le dépôt FounderOS, une fois par version du moteur :",
            `docker build -f embedded/Dockerfile -t founderos/agent-runtime:${draft.runtime_version} .`,
            "# dans le dossier de l'archive :",
            "cp .env.example .env   # collez la clé d'API de l'instance",
            "docker compose up -d --build",
          ].join("\n")}</pre>
        </details>
      </Card>

      <Card title="Clés d'API" icon={KeyIcon} hint="Une clé par instance. Elle ne donne accès qu'aux outils de CET agent, dans ses pools ; elle se révoque à tout moment.">
        <div className="flex flex-wrap gap-2">
          <Input className="h-9 w-56" value={keyLabel} onChange={(e) => setKeyLabel(e.target.value)} placeholder="ex. serveur Lyon" />
          <Button variant="outline" onClick={() => act("key", async () => { const r = await embeddedApi.createKey(agent.id, keyLabel || "clé"); setShownKey(r.key); setKeyLabel(""); })} disabled={busy === "key"}>
            <KeyIcon className="mr-1.5 h-4 w-4" /> Créer une clé
          </Button>
        </div>
        {keys.length > 0 && (
          <div className="divide-y divide-border rounded-lg border border-border">
            {keys.map((k) => (
              <div key={k.id} className={cn("flex flex-wrap items-center gap-3 px-3 py-2 text-[13px]", k.revoked_at && "opacity-50")}>
                <span className="font-mono">{k.prefix}…</span>
                <span>{k.label}</span>
                <span className="ml-auto text-[12px] text-muted-foreground">
                  {k.revoked_at ? "révoquée" : k.last_used_at ? `utilisée ${formatRelative(k.last_used_at)}` : "jamais utilisée"}
                </span>
                {!k.revoked_at && (
                  <Button size="sm" variant="ghost" onClick={() => act(`revoke-${k.id}`, () => embeddedApi.revokeKey(k.id), "Clé révoquée")}>
                    <TrashIcon className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Instances" icon={PackageIcon} hint="Les conteneurs qui tournent. Une instance en ligne bat toutes les 15 s ; ses runs apparaissent sur la fiche de l'agent.">
        <div className="flex flex-wrap items-center gap-2">
          <label className={cn("inline-flex h-9 cursor-pointer items-center rounded-md border border-border px-3 text-[13px] hover:bg-muted/50", busy === "import" && "pointer-events-none opacity-60")}>
            {busy === "import" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <UploadSimpleIcon className="mr-1.5 h-4 w-4" />} Importer un journal
            <input type="file" accept=".jsonl,.ndjson,.txt" className="hidden" onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (!file) return;
              void act("import", async () => {
                const r = await embeddedApi.importJournal(agent.id, await file.text());
                toast.success("Journal importé", `${r.imported.conversations} conversation(s), ${r.imported.runs} run(s), ${r.imported.messages} message(s)`);
              });
            }} />
          </label>
          <span className="text-[12px] text-muted-foreground">Le journal d'une instance isolée (GET /api/journal sur le site).</span>
        </div>
        {instances.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Aucune instance ne s'est encore annoncée.</p>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {instances.map((i) => {
              const live = isLive(i);
              const drift = latest && i.manifest_sha && i.manifest_sha !== latest.manifest_sha;
              return (
                <div key={i.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[13px]">
                  <span className={cn("h-2 w-2 rounded-full", live ? (i.status === "paused" ? "bg-amber-500" : "bg-emerald-500") : "bg-muted-foreground/40")} />
                  <span className="font-medium">{i.name}</span>
                  <span className="text-[12px] text-muted-foreground">
                    {i.status === "stopped" ? "arrêtée" : live ? (i.status === "paused" ? "en pause" : "en ligne") : "injoignable"}
                    {i.version ? ` · v${i.version}` : ""}
                    {i.last_seen_at ? ` · vue ${formatRelative(i.last_seen_at)}` : ""}
                  </span>
                  {drift && <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-400">configuration différente de la dernière version</span>}
                  <div className="ml-auto flex gap-1">
                    {i.status === "paused"
                      ? <IconBtn label="Reprendre" icon={PlayIcon} onClick={() => act(`c-${i.id}`, () => embeddedApi.command(agent.id, "resume", i.id))} />
                      : <IconBtn label="Pause" icon={PauseIcon} onClick={() => act(`c-${i.id}`, () => embeddedApi.command(agent.id, "pause", i.id))} />}
                    <IconBtn label="Recharger la configuration" icon={ArrowsClockwiseIcon} onClick={() => act(`c-${i.id}`, () => embeddedApi.command(agent.id, "reload", i.id), "Rechargement demandé")} />
                    {i.container_ref
                      ? <IconBtn label="Arrêter et supprimer le conteneur" icon={StopIcon} onClick={() => act(`c-${i.id}`, () => embeddedApi.stopLocal(i.id, false), "Conteneur arrêté")} />
                      : <IconBtn label="Arrêter" icon={StopIcon} onClick={() => act(`c-${i.id}`, () => embeddedApi.command(agent.id, "stop", i.id), "Arrêt demandé")} />}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Dialog open={!!shownKey} onOpenChange={(v) => { if (!v) setShownKey(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>La clé d'API</DialogTitle>
            <DialogDescription>Copiez-la maintenant dans le .env de l'instance (FOUNDEROS_API_KEY) : elle ne sera plus jamais affichée.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input readOnly className="font-mono text-[12.5px]" value={shownKey ?? ""} onFocus={(e) => e.currentTarget.select()} />
            <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard.writeText(shownKey ?? ""); toast.success("Clé copiée"); }}>
              <CopyIcon className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-[12px] text-muted-foreground">FOUNDEROS_URL={data.founderos_url}</p>
          <DialogFooter><Button onClick={() => setShownKey(null)}>C'est noté</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SeedFiles({ files, onChange }: { files: SeedFile[]; onChange: (f: SeedFile[]) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-muted-foreground">Fichiers de départ (dans /workspace)</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onChange([...files, { path: "", content: "" }])}>
          <PlusIcon className="mr-1 h-3.5 w-3.5" /> Ajouter
        </Button>
      </div>
      {files.map((f, i) => (
        <div key={i} className="space-y-1.5 rounded-lg border border-border p-2.5">
          <div className="flex gap-2">
            <Input className="h-8 font-mono text-[12.5px]" value={f.path} placeholder="ex. config/erp.yaml"
              onChange={(e) => onChange(files.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
            <Button size="sm" variant="ghost" onClick={() => onChange(files.filter((_, j) => j !== i))} aria-label="Retirer"><TrashIcon className="h-4 w-4" /></Button>
          </div>
          <Textarea rows={3} className="font-mono text-[12px]" value={f.content}
            onChange={(e) => onChange(files.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))} />
        </div>
      ))}
    </div>
  );
}

function Card({ title, icon: Icon, hint, children }: { title: string; icon: typeof PackageIcon; hint: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <div className="text-[14px] font-medium">{title}</div>
          <p className="text-[12px] text-muted-foreground">{hint}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
      <div>{children}</div>
    </label>
  );
}

/** `soon` : un choix prévu que le moteur n'applique pas encore. */
function Choice<T extends string>({ value, onChange, options, soon = [] }: { value: T; onChange: (v: T) => void; options: Array<[T, string, string]>; soon?: T[] }) {
  return (
    <div className={cn("grid gap-2", options.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
      {options.map(([k, label, hint]) => (
        <button key={k} type="button" onClick={() => onChange(k)} disabled={soon.includes(k) && value !== k}
          className={cn("rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            value === k ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50")}>
          <div className="flex items-center gap-2 text-[13px] font-medium">{label}{soon.includes(k) && <Soon />}</div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">{hint}</div>
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, desc, checked, onChange, icon: Icon = TerminalWindowIcon, soon = false }: {
  label: string; desc: string; checked: boolean; onChange: (v: boolean) => void; icon?: typeof PackageIcon; soon?: boolean;
}) {
  return (
    <div className={cn("flex items-start gap-3", soon && "opacity-60")}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] font-medium">{label}{soon && <Soon />}</div>
        <p className="text-[12px] text-muted-foreground">{desc}</p>
      </div>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} disabled={soon}
        className={cn("relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed", checked ? "bg-primary" : "bg-muted")}>
        <span className={cn("absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform", checked ? "translate-x-5" : "translate-x-0")} />
      </button>
    </div>
  );
}

function Soon() {
  return <span className="rounded-full bg-muted px-1.5 py-px font-mono text-[10px] uppercase tracking-wide text-muted-foreground">bientôt</span>;
}

function IconBtn({ label, icon: Icon, onClick }: { label: string; icon: typeof PackageIcon; onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" onClick={onClick} title={label} aria-label={label}>
      <Icon className="h-4 w-4" />
    </Button>
  );
}

/**
 * Choisir les outils du catalogue mis dans le conteneur, par catégorie, avec
 * des sélections toutes faites (presets). Le catalogue complet est dans l'onglet
 * Machines (Composer une machine).
 */
function ToolPicker({ catalog, value, onChange }: { catalog: MachineCatalog | null; value: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  if (!catalog) return <p className="text-[13px] text-muted-foreground">Le catalogue n'est pas disponible sur ce serveur.</p>;
  const label = (id: string) => catalog.tools.find((t) => t.id === id)?.name ?? id;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const chosen = value.filter((id) => catalog.tools.some((t) => t.id === id));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {catalog.presets.map((p) => (
          <button key={p.id} type="button" onClick={() => onChange([...new Set(p.tools)])} title={p.summary}
            className="rounded-full border border-border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
            {p.name}
          </button>
        ))}
      </div>
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chosen.map((id) => (
            <button key={id} type="button" onClick={() => toggle(id)} title="Retirer"
              className="rounded-md bg-muted px-1.5 py-0.5 text-[11.5px] hover:bg-muted/70">{label(id)} ✕</button>
          ))}
        </div>
      )}
      <button type="button" onClick={() => setOpen(!open)} className="text-[12px] text-muted-foreground underline-offset-2 hover:underline">
        {open ? "Masquer les outils" : chosen.length ? "Modifier les outils" : "Choisir des outils"}
      </button>
      {open && (
        <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border border-border p-3">
          {catalog.categories.map((c) => {
            const items = catalog.tools.filter((t) => t.category === c.id);
            if (!items.length) return null;
            return (
              <div key={c.id} className="space-y-1">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{c.label}</div>
                {items.map((t) => (
                  <label key={t.id} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted/40">
                    <input type="checkbox" checked={value.includes(t.id)} onChange={() => toggle(t.id)} className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-[13px]">{t.name}{t.note && <WarningIcon className="h-3.5 w-3.5 text-amber-600" />}</span>
                      <span className="block text-[11.5px] text-muted-foreground">{t.summary}</span>
                    </span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      )}
      {chosen.some((id) => catalog.tools.find((t) => t.id === id)?.category === "netsec") && (
        <p className="text-[12px] text-amber-700 dark:text-amber-400">Les outils d'audit réseau ne s'utilisent que sur des systèmes que vous êtes autorisé à tester.</p>
      )}
    </div>
  );
}
