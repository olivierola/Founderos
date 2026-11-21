import { useMemo, useState, type ReactNode } from "react";
import {
  TerminalWindowIcon, FolderLockIcon, FolderSimpleIcon, HouseLineIcon, KeyIcon, ArchiveIcon, PauseIcon, PlayIcon,
  ArrowsClockwiseIcon, ClockCounterClockwiseIcon, WifiHighIcon, WifiSlashIcon, CrownSimpleIcon, PackageIcon,
  PlusIcon, CheckIcon, CircleNotchIcon as Loader2, WarningIcon, DotsThreeIcon,
} from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AgentIdentity } from "@/components/AgentIdentity";
import { useConfirm } from "@/components/ConfirmProvider";
import { useToast } from "@/components/ToastProvider";
import { cn } from "@/lib/utils";
import {
  AUDIT_LABELS, folderSlug, formatSize, machineApi, useRefreshTeamMachine, useTeamMachineStatus,
  type MachineFolder, type TeamMachineState,
} from "./model";

interface LiteAgent { id: string; name: string; avatar_url: string | null }

/**
 * Le panneau MACHINE d'une équipe : le poste Linux qu'elle partage.
 *
 * Ce qu'il montre, c'est qui peut quoi : chaque agent et son dossier perso
 * (lui seul), le dossier commun (toute l'équipe), et les dossiers protégés —
 * avec leurs membres, les seuls à qui la plateforme présente leur secret. Le
 * secret lui-même n'apparaît nulle part, ni ici ni chez les agents.
 */
export function TeamMachineDialog({
  open, onOpenChange, dashboardId, team, agents,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  dashboardId: string;
  team: { id: string; name: string; color: string; agent_ids: string[] };
  agents: LiteAgent[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto rounded-2xl p-0">
        <DialogHeader className="border-b border-border/60 px-5 pb-3 pt-5">
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <span className="h-3 w-3 rounded-[4px]" style={{ background: team.color }} />
            Machine de l'équipe « {team.name} »
          </DialogTitle>
          <DialogDescription className="text-[12.5px] leading-relaxed">
            Un poste Linux partagé : chaque agent y est son propre utilisateur, avec un dossier perso que lui seul peut ouvrir,
            un dossier commun pour l'équipe, et des dossiers protégés réservés à leurs membres.
          </DialogDescription>
        </DialogHeader>
        {open && <TeamMachinePanel dashboardId={dashboardId} team={team} agents={agents} />}
      </DialogContent>
    </Dialog>
  );
}

function TeamMachinePanel({ dashboardId, team, agents }: {
  dashboardId: string;
  team: { id: string; name: string; agent_ids: string[] };
  agents: LiteAgent[];
}) {
  const { data, isLoading, error } = useTeamMachineStatus(dashboardId);
  const refresh = useRefreshTeamMachine(dashboardId);
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const members = team.agent_ids.map((id) => byId.get(id)).filter((a): a is LiteAgent => !!a);
  const state: TeamMachineState | undefined = data?.teams.find((t) => t.team_id === team.id);
  const machine = state?.machine ?? null;

  /** Lance une action ; rend true si elle a abouti. */
  async function run(key: string, fn: () => Promise<unknown>, done?: string): Promise<boolean> {
    setBusy(key);
    try {
      await fn();
      if (done) toast.success(done);
      await refresh();
      return true;
    } catch (e) {
      toast.error("Action impossible", e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (isLoading) {
    return <div className="flex items-center gap-2 px-5 py-8 text-[12.5px] text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Lecture de la machine…</div>;
  }
  if (error || !data) {
    return (
      <p className="m-5 rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
        {error instanceof Error ? error.message : "État de la machine illisible."} (Migration 0296 et fonction team-machine déployées ?)
      </p>
    );
  }

  return (
    <div className="space-y-5 px-5 pb-5 pt-4">
      {/* Branchement : la plateforme sait-elle où est la machine, et répond-elle ? */}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {!data.configured ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/12 px-2.5 py-1 text-amber-700 dark:text-amber-400">
            <WarningIcon className="h-3.5 w-3.5" /> Non branchée : TEAM_MACHINE_URL et TEAM_MACHINE_TOKEN manquent côté serveur
          </span>
        ) : data.live.reachable ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/12 px-2.5 py-1 text-emerald-700 dark:text-emerald-400">
            <WifiHighIcon className="h-3.5 w-3.5" /> Machine joignable
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1 text-destructive" title={data.live.error}>
            <WifiSlashIcon className="h-3.5 w-3.5" /> Machine injoignable{data.live.error ? ` — ${data.live.error.slice(0, 90)}` : ""}
          </span>
        )}
        {machine && (
          <span className={cn("rounded-full px-2.5 py-1",
            machine.status === "active" ? "bg-muted text-foreground" : "bg-amber-500/12 text-amber-700 dark:text-amber-400")}>
            {machine.status === "active" ? "Active" : "En pause"}
          </span>
        )}
        {state?.live?.usage_kb != null && (
          <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">{formatSize(state.live.usage_kb)} sur le disque</span>
        )}
      </div>

      {!machine ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
          <TerminalWindowIcon className="mx-auto h-7 w-7 text-muted-foreground/60" />
          <p className="mt-2 text-[13px] font-medium">Cette équipe n'a pas encore de machine</p>
          <p className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-muted-foreground">
            Ses agents pourront y créer des dossiers et des fichiers, lancer des commandes, tester, faire tourner des serveurs —
            chacun sous sa propre identité. Les outils team_* apparaîtront dans leur boîte à outils.
          </p>
          <button
            type="button" disabled={busy === "enable" || !members.length}
            onClick={() => run("enable", () => machineApi.enable(dashboardId, team.id), "Machine attribuée")}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy === "enable" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TerminalWindowIcon className="h-3.5 w-3.5" />}
            Donner une machine à l'équipe
          </button>
          {!members.length && <p className="mt-2 text-[11.5px] text-muted-foreground">Ajoutez d'abord des agents à l'équipe.</p>}
        </div>
      ) : (
        <>
          {machine.last_error && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11.5px] text-amber-800 dark:text-amber-300">
              Dernière erreur : {machine.last_error}
            </p>
          )}

          {/* Les lieux */}
          <section className="space-y-1.5">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Les lieux</h3>
            <Place icon={<FolderSimpleIcon className="h-4 w-4" />} path={`${machine.machine_path ?? `/teams/${machine.team_key}`}/commun`}
              who={`Toute l'équipe (${members.length} agent${members.length > 1 ? "s" : ""})`} />
            <Place icon={<HouseLineIcon className="h-4 w-4" />} path={`${machine.machine_path ?? `/teams/${machine.team_key}`}/home/<agent>`}
              who="Chaque agent, seul dans le sien" />
          </section>

          {/* Les agents et leur identité */}
          <section className="space-y-1.5">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Les agents</h3>
            <div className="divide-y divide-border/50 rounded-xl border border-border/60">
              {members.map((a) => {
                const ident = state?.agents.find((x) => x.agent_id === a.id);
                const jobs = state?.live?.agents.find((x) => x.id === a.id)?.jobs_running ?? 0;
                return (
                  <div key={a.id} className="flex items-center gap-2.5 px-3 py-2">
                    <AgentIdentity url={a.avatar_url} seed={a.name} size={22} rounded="rounded-md" interactive={false} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-medium">{a.name}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {ident ? `${ident.unix_user} · ${ident.home_path}` : "identité créée à son premier appel"}
                      </p>
                    </div>
                    {jobs > 0 && <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px]">{jobs} job{jobs > 1 ? "s" : ""}</span>}
                    {ident && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button type="button" aria-label={`Options de ${a.name}`} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                            <DotsThreeIcon className="h-4 w-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="rounded-xl">
                          <DropdownMenuItem onSelect={async () => {
                            if (!(await confirm({
                              title: `Réinitialiser l'identité de ${a.name} ?`,
                              description: "Un nouveau secret d'agent est généré. Ses fichiers restent les siens ; ce qu'il fait tourner s'arrête.",
                              confirmText: "Réinitialiser",
                            }))) return;
                            void run(`reset-${a.id}`, () => machineApi.resetAgent(team.id, a.id), "Identité réinitialisée");
                          }}>
                            <KeyIcon className="mr-2 h-3.5 w-3.5" /> Réinitialiser son identité
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                );
              })}
              {!members.length && <p className="px-3 py-3 text-[12px] text-muted-foreground">Aucun agent dans l'équipe.</p>}
            </div>
          </section>

          {/* Les dossiers protégés */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Dossiers protégés</h3>
            </div>
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              Fermés à tous les autres agents par le noyau Linux. Chaque dossier a son secret, que la plateforme présente
              à la machine pour ses seuls membres — aucun agent ne le voit, il ne peut donc pas le transmettre.
            </p>
            {(state?.folders ?? []).map((f) => (
              <FolderCard
                key={f.id} folder={f} members={members} byId={byId} busy={busy}
                onMembers={(add, remove) => run(`m-${f.id}`, () => machineApi.members(f.id, add, remove), "Membres mis à jour")}
                onRotate={async () => {
                  if (!(await confirm({
                    title: `Renouveler le secret de « ${f.name} » ?`,
                    description: "L'ancien secret n'ouvre plus rien. Les membres actuels gardent l'accès ; ce qui tournait avec l'ancien s'arrête.",
                    confirmText: "Renouveler", destructive: false,
                  }))) return;
                  void run(`r-${f.id}`, () => machineApi.rotate(f.id), "Secret renouvelé");
                }}
                onArchive={async () => {
                  if (!(await confirm({
                    title: `Archiver « ${f.name} » ?`,
                    description: "Plus aucun agent ne pourra l'ouvrir. Son contenu est conservé sur la machine, hors d'atteinte des agents (.archives).",
                    confirmText: "Archiver",
                  }))) return;
                  void run(`a-${f.id}`, () => machineApi.archive(f.id), "Dossier archivé");
                }}
              />
            ))}
            <NewFolder members={members} busy={busy === "create"}
              onCreate={(input) => run("create", () => machineApi.createFolder(team.id, input), "Dossier protégé créé")} />
          </section>

          {/* Réglages */}
          <section className="space-y-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Réglages</h3>
            <label className="flex items-center gap-2.5 rounded-xl border border-border/60 px-3 py-2">
              <PackageIcon className="h-4 w-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-[12.5px]">
                Paquets système (apt)
                <span className="block text-[11px] text-muted-foreground">
                  Les agents peuvent demander l'installation de paquets pour toute la machine
                  {data.live.apt === false ? " — encore faut-il que la machine l'autorise (MACHINE_ALLOW_APT=1)" : ""}.
                </span>
              </span>
              <input
                type="checkbox" className="h-4 w-4 accent-foreground" checked={machine.allow_system_packages}
                disabled={busy === "apt"}
                onChange={(e) => run("apt", () => machineApi.settings(team.id, { allow_system_packages: e.target.checked }))}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {machine.status === "active" ? (
                <button
                  type="button" disabled={busy === "pause"}
                  onClick={async () => {
                    if (!(await confirm({
                      title: "Mettre la machine en pause ?",
                      description: "Les agents perdent leurs outils team_* et tout ce qui tourne s'arrête. Les fichiers restent.",
                      confirmText: "Mettre en pause",
                    }))) return;
                    void run("pause", () => machineApi.pause(team.id), "Machine en pause");
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-muted/70 px-2.5 py-1.5 text-[12px] font-medium hover:bg-muted disabled:opacity-50"
                >
                  <PauseIcon className="h-3.5 w-3.5" /> Mettre en pause
                </button>
              ) : (
                <button
                  type="button" disabled={busy === "enable"}
                  onClick={() => run("enable", () => machineApi.enable(dashboardId, team.id), "Machine relancée")}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-2.5 py-1.5 text-[12px] font-medium text-background hover:opacity-90 disabled:opacity-50"
                >
                  <PlayIcon className="h-3.5 w-3.5" /> Relancer
                </button>
              )}
            </div>
          </section>

          {/* Journal */}
          {(state?.audit.length ?? 0) > 0 && (
            <section className="space-y-1.5">
              <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                <ClockCounterClockwiseIcon className="h-3.5 w-3.5" /> Journal
              </h3>
              <ul className="space-y-1">
                {state!.audit.map((row) => {
                  const folder = state!.folders.find((f) => f.id === row.folder_id);
                  const who = row.agent_id ? byId.get(row.agent_id)?.name ?? "Un agent" : "Un humain";
                  const targets = Array.isArray(row.detail?.agents)
                    ? (row.detail.agents as string[]).map((id) => byId.get(id)?.name ?? id.slice(0, 6)).join(", ")
                    : "";
                  return (
                    <li key={row.id} className="text-[11.5px] text-muted-foreground">
                      <span className="text-foreground">{who}</span> {AUDIT_LABELS[row.action] ?? row.action}
                      {folder ? ` « ${folder.name} »` : row.detail?.name ? ` « ${String(row.detail.name)} »` : ""}
                      {targets ? ` : ${targets}` : ""}
                      {Array.isArray(row.detail?.packages) ? ` : ${(row.detail.packages as string[]).join(", ")}` : ""}
                      <span className="ml-1.5 opacity-70">{new Date(row.created_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Place({ icon, path, who }: { icon: ReactNode; path: string; who: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-border/60 px-3 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <code className="min-w-0 flex-1 truncate text-[11.5px]">{path}</code>
      <span className="shrink-0 text-[11px] text-muted-foreground">{who}</span>
    </div>
  );
}

function FolderCard({ folder, members, byId, busy, onMembers, onRotate, onArchive }: {
  folder: MachineFolder;
  members: LiteAgent[];
  byId: Map<string, LiteAgent>;
  busy: string | null;
  onMembers: (add: string[], remove: string[]) => void;
  onRotate: () => void;
  onArchive: () => void;
}) {
  const current = new Set(folder.members.map((m) => m.agent_id));
  const [draft, setDraft] = useState<Set<string>>(current);
  const changed = draft.size !== current.size || [...draft].some((id) => !current.has(id));
  const working = busy === `m-${folder.id}` || busy === `r-${folder.id}` || busy === `a-${folder.id}`;

  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-3">
      <div className="flex items-center gap-2">
        <FolderLockIcon className="h-4 w-4 text-muted-foreground" />
        <span className="text-[13px] font-medium">{folder.name}</span>
        <code className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">{folder.path}</code>
        {working && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`Options de ${folder.name}`} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              <DotsThreeIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="rounded-xl">
            <DropdownMenuItem onSelect={onRotate}><ArrowsClockwiseIcon className="mr-2 h-3.5 w-3.5" /> Renouveler le secret</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onArchive}>
              <ArchiveIcon className="mr-2 h-3.5 w-3.5" /> Archiver
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {folder.purpose && <p className="mt-1 text-[11.5px] text-muted-foreground">{folder.purpose}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {folder.members.map((m) => {
          const a = byId.get(m.agent_id);
          return (
            <span key={m.agent_id} className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/60 py-0.5 pl-0.5 pr-2 text-[11.5px]">
              <AgentIdentity url={a?.avatar_url ?? null} seed={a?.name ?? m.agent_id} size={16} rounded="rounded-full" interactive={false} />
              {a?.name ?? m.agent_id.slice(0, 8)}
              {m.role === "owner" && <CrownSimpleIcon className="h-3 w-3 text-amber-500" weight="fill" aria-label="propriétaire" />}
              {!members.some((x) => x.id === m.agent_id) && (
                <span className="text-[10px] text-amber-600" title="Cet agent a quitté l'équipe : il n'a plus accès à la machine, ni donc à ce dossier.">hors équipe</span>
              )}
            </span>
          );
        })}
        <Popover onOpenChange={(o) => { if (o) setDraft(new Set(current)); }}>
          <PopoverTrigger asChild>
            <button type="button" className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-foreground/30 hover:text-foreground">
              <PlusIcon className="h-3 w-3" /> Membres
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 rounded-xl p-1.5">
            <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium text-muted-foreground">Qui peut ouvrir « {folder.name} »</p>
            {members.map((a) => {
              const on = draft.has(a.id);
              return (
                <button key={a.id} type="button"
                  onClick={() => setDraft((d) => { const n = new Set(d); if (on) n.delete(a.id); else n.add(a.id); return n; })}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-muted">
                  <span className={cn("flex h-4 w-4 items-center justify-center rounded border", on ? "border-transparent bg-foreground text-background" : "border-border")}>
                    {on && <CheckIcon className="h-3 w-3" weight="bold" />}
                  </span>
                  <AgentIdentity url={a.avatar_url} seed={a.name} size={18} rounded="rounded-md" interactive={false} />
                  <span className="truncate">{a.name}</span>
                </button>
              );
            })}
            <button
              type="button" disabled={!changed || draft.size === 0}
              onClick={() => onMembers([...draft].filter((id) => !current.has(id)), [...current].filter((id) => !draft.has(id)))}
              className="mt-1 w-full rounded-lg bg-foreground px-2 py-1.5 text-[12px] font-medium text-background disabled:opacity-40"
            >
              {draft.size === 0 ? "Au moins un membre" : "Appliquer"}
            </button>
            <p className="px-2 pt-1.5 text-[10.5px] leading-snug text-muted-foreground">Un membre retiré perd l'accès à son prochain appel ; ce qu'il faisait tourner dans le dossier s'arrête.</p>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

function NewFolder({ members, busy, onCreate }: {
  members: LiteAgent[];
  busy: boolean;
  onCreate: (input: { name: string; purpose: string; memberIds: string[]; ownerId: string | null }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [owner, setOwner] = useState<string | null>(null);
  const slug = folderSlug(name);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-[12.5px] font-medium hover:bg-muted">
        <PlusIcon className="h-3.5 w-3.5" /> Nouveau dossier protégé
      </button>
    );
  }
  return (
    <div className="space-y-2.5 rounded-xl border border-border/60 p-3">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du dossier (ex. rachat-concurrent)"
        className="w-full rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-[12.5px] outline-none focus:border-foreground/30" />
      {name && <p className="text-[11px] text-muted-foreground">Sur la machine : <code>dossiers/{slug || "—"}</code></p>}
      <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="À quoi il sert, en une phrase (montré à ses membres)"
        className="w-full rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-[12.5px] outline-none focus:border-foreground/30" />
      <div>
        <p className="mb-1 text-[11.5px] font-medium">Membres — les seuls à pouvoir l'ouvrir</p>
        <div className="flex flex-wrap gap-1.5">
          {members.map((a) => {
            const on = picked.includes(a.id);
            return (
              <button key={a.id} type="button"
                onClick={() => {
                  setPicked((p) => (on ? p.filter((x) => x !== a.id) : [...p, a.id]));
                  if (on && owner === a.id) setOwner(null);
                }}
                className={cn("inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2 text-[11.5px] transition-colors",
                  on ? "border-foreground/40 bg-foreground/[0.06]" : "border-border/60 text-muted-foreground hover:text-foreground")}>
                <AgentIdentity url={a.avatar_url} seed={a.name} size={16} rounded="rounded-full" interactive={false} />
                {a.name}
                {on && (
                  <span role="button" tabIndex={0} title={owner === a.id ? "Propriétaire" : "Désigner propriétaire"}
                    onClick={(e) => { e.stopPropagation(); setOwner(owner === a.id ? null : a.id); }}
                    className={cn("rounded-full", owner === a.id ? "text-amber-500" : "text-muted-foreground/50 hover:text-amber-500")}>
                    <CrownSimpleIcon className="h-3 w-3" weight={owner === a.id ? "fill" : "regular"} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[10.5px] text-muted-foreground">La couronne désigne l'agent qui pourra lui-même gérer les membres. Sans propriétaire, seuls les humains les gèrent.</p>
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={!slug || !picked.length || busy}
          onClick={async () => {
            if (!(await onCreate({ name: slug, purpose: purpose.trim(), memberIds: picked, ownerId: owner }))) return;
            setOpen(false); setName(""); setPurpose(""); setPicked([]); setOwner(null);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-[12px] font-medium text-background disabled:opacity-40">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderLockIcon className="h-3.5 w-3.5" />} Créer
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-muted">Annuler</button>
      </div>
    </div>
  );
}
