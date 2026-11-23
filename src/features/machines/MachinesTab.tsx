import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  PlusIcon, DesktopTowerIcon, ArrowsClockwiseIcon, PulseIcon, FolderOpenIcon,
  SlidersHorizontalIcon, PackageIcon, CircleNotchIcon as Loader2,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ToastProvider";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/features/tracker/pickers";
import {
  embeddedHealth, fleetApi, formatAge, formatKb, HEALTH_META, KIND_LABEL, machineHealth, useFleet, useRefreshFleet,
  type EmbeddedMachine, type Fleet, type FleetMachine, type MachineKind,
} from "./api";
import { MachineActivity } from "./MachineActivity";
import { MachineFiles } from "./MachineFiles";
import { MachineAssignments } from "./MachineAssignments";
import { MachineConfig } from "./MachineConfig";
import { KIND_ICON } from "./kinds";
import { CATEGORY_ICON, MachineCatalog } from "./MachineCatalog";

/**
 * Les machines du service (0304) : où les agents travaillent. Une machine est
 * un vrai poste Linux (un conteneur team-machine sur un poste, une VM, la
 * machine de la plateforme) ; on la donne à une équipe ou à un agent, et
 * chaque agent y a son compte.
 *
 *   /machines                 vue d'ensemble
 *   /machines/activite        ce qui tourne, le journal
 *   /machines/fichiers        le système de fichiers, vu par un agent
 *   /machines/attributions    qui travaille sur quelle machine
 *   /machines/configuration   nom, adresse, jeton, pause
 *   /machines/catalogue       les machines taillées par métier (cyber, data, dev…)
 *
 * La machine choisie suit dans l'adresse (?m=), d'un sous-onglet à l'autre.
 */
export type MachinesView = "overview" | "activite" | "fichiers" | "attributions" | "configuration" | "catalogue";

const VIEW_TITLE: Record<MachinesView, { title: string; sub: string }> = {
  overview: { title: "Machines", sub: "Les postes où vos agents travaillent : un compte Linux par agent, un dossier par équipe." },
  activite: { title: "Activité", sub: "Ce qui tourne en ce moment, et ce qui s'est passé." },
  fichiers: { title: "Fichiers", sub: "Le système de fichiers, tel qu'un agent le voit." },
  attributions: { title: "Attributions", sub: "Qui travaille sur quelle machine." },
  configuration: { title: "Configuration", sub: "Adresse, jeton, paquets système, pause." },
  catalogue: { title: "Composer une machine", sub: "Partez d'une machine de base et choisissez ses outils dans le catalogue, par catégorie. Pour vos équipes, ou pour y embarquer un agent." },
};


export function MachinesTab({ dashboardId, base, sub }: { dashboardId: string; base: string; sub: string | null }) {
  const view: MachinesView = (["activite", "fichiers", "attributions", "configuration", "catalogue"] as const).find((v) => v === sub) ?? "overview";
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: fleet, isLoading, error } = useFleet(dashboardId);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (params.get("new") !== "1") return;
    setCreating(true);
    const next = new URLSearchParams(params);
    next.delete("new");
    setParams(next, { replace: true });
  }, [params, setParams]);

  const machines = fleet?.machines ?? [];
  const selectedId = params.get("m") && machines.some((m) => m.id === params.get("m")) ? params.get("m")! : machines[0]?.id ?? null;
  const selected = machines.find((m) => m.id === selectedId) ?? null;
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("m", id);
    setParams(next, { replace: true });
  };
  const open = (v: MachinesView, id: string) => navigate(`${base}/machines${v === "overview" ? "" : `/${v}`}?m=${id}`);
  const head = VIEW_TITLE[view];
  const needsMachine = view === "activite" || view === "fichiers" || view === "configuration";

  return (
    <div className="w-full px-5 py-7 md:px-6">
      <header className="mb-6 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-semibold tracking-tight">{head.title}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{head.sub}</p>
        </div>
        {needsMachine && machines.length > 0 && (
          <MachinePicker machines={machines} value={selectedId} onChange={select} />
        )}
        {view === "overview" && (
          <Button onClick={() => setCreating(true)} className="shrink-0">
            <PlusIcon className="mr-1.5 h-4 w-4" /> Ajouter une machine
          </Button>
        )}
      </header>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{error instanceof Error ? error.message : String(error)}</p>
      ) : !fleet ? null : view === "catalogue" ? (
        <MachineCatalog dashboardId={dashboardId} base={base} fleet={fleet} />
      ) : view === "attributions" ? (
        <MachineAssignments dashboardId={dashboardId} fleet={fleet} />
      ) : view === "overview" ? (
        machines.length === 0 && !(fleet.embedded ?? []).length ? (
          <EmptyFleet onAdd={() => setCreating(true)} />
        ) : (
          <div className="space-y-8">
            {machines.length > 0 && (
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))]">
                {machines.map((m) => <MachineCard key={m.id} machine={m} fleet={fleet} dashboardId={dashboardId} onOpen={(v) => open(v, m.id)} />)}
              </div>
            )}
            {(fleet.embedded ?? []).length > 0 && (
              <section className="space-y-3">
                <div>
                  <h2 className="text-[15px] font-semibold">Machines des agents embarqués</h2>
                  <p className="text-[12.5px] text-muted-foreground">Le conteneur de chaque instance, tel qu'il se décrit à chaque battement de cœur. Il se pilote depuis l'onglet Agents embarqués.</p>
                </div>
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))]">
                  {(fleet.embedded ?? []).map((m) => (
                    <EmbeddedMachineCard key={m.id} machine={m} fleet={fleet} onOpen={() => navigate(`${base}/embedded?a=${m.agent_id}`)} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )
      ) : machines.length === 0 ? (
        <EmptyFleet onAdd={() => setCreating(true)} />
      ) : !selected ? null : view === "activite" ? (
        <MachineActivity machine={selected} fleet={fleet} dashboardId={dashboardId} base={base} />
      ) : view === "fichiers" ? (
        <MachineFiles key={selected.id} machine={selected} fleet={fleet} />
      ) : (
        <MachineConfig key={selected.id} machine={selected} dashboardId={dashboardId} onDeleted={() => navigate(`${base}/machines`)} />
      )}

      <NewMachineDialog open={creating} onOpenChange={setCreating} dashboardId={dashboardId}
        provisioner={fleet?.provisioner}
        onCreated={(id) => open("overview", id)} />
    </div>
  );
}

function MachinePicker({ machines, value, onChange }: { machines: FleetMachine[]; value: string | null; onChange: (id: string) => void }) {
  return (
    <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-muted/60 p-1 scrollbar-hide">
      {machines.map((m) => {
        const Icon = KIND_ICON[m.kind] ?? DesktopTowerIcon;
        const h = HEALTH_META[machineHealth(m)];
        return (
          <button
            key={m.id}
            onClick={() => onChange(m.id)}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition-colors",
              value === m.id ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
            <span className="max-w-[160px] truncate">{m.name}</span>
            <span className={cn("h-1.5 w-1.5 rounded-full", h.dot)} title={h.label} />
          </button>
        );
      })}
    </div>
  );
}

function EmptyFleet({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <DesktopTowerIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
      <p className="text-sm font-medium">Aucune machine</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Déclarez la machine de la plateforme, un conteneur Docker ou une VM : vos agents y auront chacun leur compte.
      </p>
      <Button className="mt-5" onClick={onAdd}><PlusIcon className="mr-1.5 h-4 w-4" /> Ajouter une machine</Button>
    </div>
  );
}

function Meter({ label, used, total, value }: { label: string; used?: number; total?: number; value?: string }) {
  const pct = used != null && total ? Math.min(100, Math.round((used / total) * 100)) : null;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="truncate font-medium tabular-nums">{value ?? (pct == null ? "–" : `${pct} %`)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        {pct != null && <div className={cn("h-full rounded-full", pct > 85 ? "bg-amber-500" : "bg-primary")} style={{ width: `${Math.max(2, pct)}%` }} />}
      </div>
    </div>
  );
}

function MachineCard({ machine: m, fleet, dashboardId, onOpen }: {
  machine: FleetMachine; fleet: Fleet; dashboardId: string; onOpen: (v: MachinesView) => void;
}) {
  const toast = useToast();
  const refresh = useRefreshFleet(dashboardId);
  const [probing, setProbing] = useState(false);
  const health = HEALTH_META[machineHealth(m)];
  const preset = m.template ? fleet.catalog?.presets.find((p) => p.id === m.template) ?? null : null;
  const toolCount = m.tools?.length ?? 0;
  // Une machine composée depuis un preset porte l'icône de sa catégorie.
  const Icon = (preset && CATEGORY_ICON[preset.category]) || (KIND_ICON[m.kind] ?? DesktopTowerIcon);
  const info = m.info ?? {};
  const here = fleet.assignments.filter((a) => a.machine_id === m.id && a.status === "active");
  const teams = here.filter((a) => a.scope === "team").length;
  const solo = here.filter((a) => a.scope === "agent").length;
  const creatingNow = m.provision_state === "creating";

  const probe = async () => {
    setProbing(true);
    try {
      const r = await fleetApi.probe(m.id);
      if (r.probe.reachable) toast.success("Machine joignable", r.probe.latency_ms != null ? `${r.probe.latency_ms} ms` : undefined);
      else toast.error("Machine injoignable", r.probe.error);
      await refresh();
    } catch (e) {
      toast.error("Test impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  };

  return (
    // Toute la carte ouvre ce qui se passe sur la machine ; ses boutons gardent leur geste.
    <article
      role="button" tabIndex={0}
      onClick={() => onOpen("activite")}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen("activite"); }}
      title="Voir tout ce qui se passe sur cette machine"
      className="flex cursor-pointer flex-col rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold tracking-tight">{m.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground">
            <span>{KIND_LABEL[m.kind]}</span>
            {preset && <span className="rounded bg-muted px-1.5 py-px text-[11px] text-foreground/80">{preset.name}</span>}
            {toolCount > 0 && <span className="text-[11.5px]">{toolCount} outil{toolCount > 1 ? "s" : ""}</span>}
            {info.version && <span className="font-mono text-[11.5px]">v{info.version}</span>}
          </div>
        </div>
        <span className={cn("flex shrink-0 items-center gap-1.5 text-[12px] font-medium", health.text)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", health.dot)} /> {health.label}
        </span>
      </div>

      <p className="mt-3 line-clamp-2 min-h-[2.5em] text-[13px] leading-relaxed text-muted-foreground">
        {m.description || (m.managed_by
          ? "Un conteneur créé par la plateforme sur ce poste."
          : m.url ? m.url : "La machine de la plateforme, jointe par son adresse configurée.")}
      </p>

      {creatingNow ? (
        <p className="mt-3 flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-[12.5px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Préparation du conteneur. La première fois, l'image se construit : quelques minutes.
        </p>
      ) : (<>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <Meter label="CPU" value={info.load ? `${info.load[0]} / ${info.cpus ?? "?"}` : undefined} used={info.load?.[0]} total={info.cpus} />
        <Meter label="Mémoire" used={info.mem ? info.mem.total_kb - info.mem.free_kb : undefined} total={info.mem?.total_kb} />
        <Meter label="Disque" used={info.disk ? info.disk.total_kb - info.disk.free_kb : undefined} total={info.disk?.total_kb} />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
        <span><b className="font-semibold tabular-nums text-foreground">{teams}</b> équipe{teams > 1 ? "s" : ""}</span>
        <span><b className="font-semibold tabular-nums text-foreground">{solo}</b> agent{solo > 1 ? "s" : ""} seul{solo > 1 ? "s" : ""}</span>
        {info.mem && <span>{formatKb(info.mem.total_kb)} RAM</span>}
        {info.browser && <span>navigateur</span>}
        {info.uptime_s != null && <span>allumée depuis {formatAge(info.uptime_s)}</span>}
      </div>
      </>)}

      {m.last_error && (
        <p className="mt-3 line-clamp-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-[12px] text-red-700 dark:text-red-400" title={m.last_error}>{m.last_error}</p>
      )}

      <div className="mt-4 flex items-center gap-1 border-t border-border/60 pt-3" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[12.5px]" onClick={() => onOpen("activite")}>
          <PulseIcon className="h-3.5 w-3.5" /> Activité
        </Button>
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[12.5px]" onClick={() => onOpen("fichiers")}>
          <FolderOpenIcon className="h-3.5 w-3.5" /> Fichiers
        </Button>
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[12.5px]" onClick={() => onOpen("configuration")}>
          <SlidersHorizontalIcon className="h-3.5 w-3.5" /> Configurer
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[12.5px] text-muted-foreground" onClick={probe} disabled={probing || creatingNow}
          title={m.last_seen_at ? `Vue ${formatRelative(m.last_seen_at)}` : "Jamais jointe"}>
          {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowsClockwiseIcon className="h-3.5 w-3.5" />} Tester
        </Button>
      </div>
    </article>
  );
}

const EMBEDDED_HEALTH = {
  online: HEALTH_META.online,
  paused: HEALTH_META.paused,
  offline: HEALTH_META.offline,
  stopped: { label: "Arrêtée", dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
} as const;

const CONNECTIVITY_LABEL = { connected: "connecté", intermittent: "intermittent", isolated: "isolé" } as const;

/** Le conteneur d'une instance d'agent embarqué : mêmes jauges qu'une machine d'équipe, pilotage dans l'onglet de l'agent. */
function EmbeddedMachineCard({ machine: m, fleet, onOpen }: { machine: EmbeddedMachine; fleet: Fleet; onOpen: () => void }) {
  const health = EMBEDDED_HEALTH[embeddedHealth(m)];
  const info = m.info ?? {};
  const toolNames = m.tools.map((id) => fleet.catalog?.tools.find((t) => t.id === id)?.name ?? id);
  return (
    <article
      role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
      title="Ouvrir l'agent embarqué"
      className="flex cursor-pointer flex-col rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          <PackageIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold tracking-tight">{m.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground">
            <span>Agent embarqué · {m.agent_name}</span>
            {m.version != null && <span className="font-mono text-[11.5px]">v{m.version}</span>}
          </div>
        </div>
        <span className={cn("flex shrink-0 items-center gap-1.5 text-[12px] font-medium", health.text)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", health.dot)} /> {health.label}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        <Meter label="CPU" value={info.load ? `${info.load[0]} / ${info.cpus ?? "?"}` : undefined} used={info.load?.[0]} total={info.cpus} />
        <Meter label="Mémoire" used={info.mem ? info.mem.total_kb - info.mem.free_kb : undefined} total={info.mem?.total_kb} />
        <Meter label="Disque" used={info.disk ? info.disk.total_kb - info.disk.free_kb : undefined} total={info.disk?.total_kb} />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
        <span>{CONNECTIVITY_LABEL[m.connectivity] ?? m.connectivity}</span>
        {info.mem && <span>{formatKb(info.mem.total_kb)} RAM</span>}
        {info.uptime_s != null && <span>allumée depuis {formatAge(info.uptime_s)}</span>}
        {m.last_seen_at && <span>vue {formatRelative(m.last_seen_at)}</span>}
      </div>

      {toolNames.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {toolNames.slice(0, 6).map((n) => <span key={n} className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-foreground/80">{n}</span>)}
          {toolNames.length > 6 && <span className="px-1 text-[11px] text-muted-foreground">+{toolNames.length - 6}</span>}
        </div>
      )}

      {!m.last_seen_at && (
        <p className="mt-3 text-[12px] text-muted-foreground">Ne s'est pas encore décrite : elle le fera à son prochain battement de cœur.</p>
      )}
    </article>
  );
}

function NewMachineDialog({ open, onOpenChange, dashboardId, provisioner, onCreated }: {
  open: boolean; onOpenChange: (v: boolean) => void; dashboardId: string;
  provisioner?: { available: boolean; reason?: string }; onCreated: (id: string) => void;
}) {
  const canCreate = !!provisioner?.available;
  const toast = useToast();
  const refresh = useRefreshFleet(dashboardId);
  const [where, setWhere] = useState<"create" | "url">(canCreate ? "create" : "url");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<MachineKind>("docker");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setWhere(canCreate ? "create" : "url");
    setName(""); setDescription(""); setUrl(""); setToken(""); setKind("vm");
  }, [open, canCreate]);

  const submit = async () => {
    setSaving(true);
    if (where === "create") {
      try {
        const r = await fleetApi.provision(dashboardId, {
          name: name.trim() || "Nouvelle machine", description: description.trim() || undefined,
        });
        toast.success("Création lancée", "La machine apparaît dans le parc et sera prête dans une minute.");
        await refresh();
        onOpenChange(false);
        onCreated(r.machine.id);
      } catch (e) {
        toast.error("Création impossible", e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
      return;
    }
    try {
      const r = await fleetApi.create(dashboardId, {
        name: name.trim() || "Nouvelle machine",
        description: description.trim() || undefined, kind,
        url: url.trim(), token: token.trim(),
      });
      if (r.probe?.reachable) toast.success("Machine ajoutée", "Elle répond.");
      else toast.info("Machine ajoutée", r.probe?.error ? `Pas encore joignable : ${r.probe.error}` : undefined);
      await refresh();
      onOpenChange(false);
      onCreated(r.machine.id);
    } catch (e) {
      toast.error("Ajout impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Ajouter une machine</DialogTitle>
          <DialogDescription>Un poste qui fait tourner le superviseur team-machine (conteneur Docker, VM, serveur).</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {([
              ["create", "Créer une machine", canCreate ? "Un nouveau conteneur, lancé pour vous sur ce poste." : (provisioner?.reason ?? "Indisponible ici.")],
              ["url", "Brancher une machine", "Un superviseur team-machine qui tourne déjà : son adresse et son jeton."],
            ] as const).map(([k, label, hint]) => (
              <button
                key={k} type="button" disabled={k === "create" && !canCreate}
                onClick={() => setWhere(k)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  where === k ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
                )}
              >
                <div className="text-[13px] font-medium">{label}</div>
                <div className="mt-0.5 text-[12px] text-muted-foreground">{hint}</div>
              </button>
            ))}
          </div>
          <label className="block">
            <span className="text-[12px] font-medium text-muted-foreground">Nom</span>
            <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. VM de calcul" />
          </label>
          <label className="block">
            <span className="text-[12px] font-medium text-muted-foreground">Description</span>
            <Textarea className="mt-1" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="À quoi elle sert, ce qu'elle a d'installé" />
          </label>
          {where !== "create" && (
          <div>
            <span className="text-[12px] font-medium text-muted-foreground">Type</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {(["docker", "vm", "cloud"] as const).map((k) => {
                const Icon = KIND_ICON[k];
                return (
                  <button key={k} type="button" onClick={() => setKind(k)}
                    className={cn("flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12.5px] transition-colors",
                      kind === k ? "border-primary bg-primary/5 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
                    <Icon className="h-3.5 w-3.5" /> {KIND_LABEL[k]}
                  </button>
                );
              })}
            </div>
          </div>
          )}
          {where === "url" && (
            <>
              <label className="block">
                <span className="text-[12px] font-medium text-muted-foreground">Adresse</span>
                <Input className="mt-1 font-mono text-[13px]" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://ma-machine.exemple.com" />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-muted-foreground">Jeton de la machine (MACHINE_TOKEN)</span>
                <Input className="mt-1 font-mono text-[13px]" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="32 caractères au moins" />
                <span className="mt-1 block text-[11.5px] text-muted-foreground">Chiffré, jamais réaffiché ni donné aux agents.</span>
              </label>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button onClick={submit} disabled={saving || (where === "url" && (!url.trim() || token.trim().length < 32))}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} {where === "create" ? "Créer" : "Ajouter"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
