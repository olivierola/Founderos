import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  PlusIcon, TrashIcon, CrownSimpleIcon, UsersThreeIcon, ChatsCircleIcon, CursorClickIcon,
  CheckIcon, XIcon, CircleNotchIcon as Loader2, CubeIcon, DotsThreeIcon, TerminalWindowIcon,
} from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { AgentIdentity } from "@/components/AgentIdentity";
import { useAuth } from "@/lib/auth-context";
import { useConfirm } from "@/components/ConfirmProvider";
import { cn } from "@/lib/utils";
import { TEAM_COLORS, assignAgentToTeam, newTeam, type AgentTeam } from "../model";
import { useTeams, useLiteAgents, gatherTeam, type LiteAgent } from "./teams";
import { TeamMachineDialog } from "@/features/team-machine/TeamMachinePanel";
import { useTeamMachineFlags } from "@/features/team-machine/model";

// Constituer les équipes — le même écran dans les réglages du tableau et dans
// le tiroir du Live Space. Tout s'enregistre au geste : il n'y a pas de bouton
// « Enregistrer » à oublier, et la scène suit à l'instant.

export function TeamsManager({
  dashboard, workspaceId, projectId, compact, editingTeamId, onEditTeam, onOpenLive,
}: {
  dashboard: { id: string; name: string };
  workspaceId: string | null;
  projectId: string | null;
  /** Dans le tiroir du Live Space : plus serré. */
  compact?: boolean;
  /** L'équipe qu'on compose en cliquant les agents DANS la scène. */
  editingTeamId?: string | null;
  onEditTeam?: (teamId: string | null) => void;
  onOpenLive?: () => void;
}) {
  const { teams, mutate, error, teamLife, setTeamLife } = useTeams(dashboard.id);
  const { data: agents } = useLiteAgents(dashboard.id);
  const { data: machineFlags } = useTeamMachineFlags(dashboard.id);
  const navigate = useNavigate();
  const all = agents ?? [];
  const byId = new Map(all.map((a) => [a.id, a]));
  const teamOf = new Map<string, AgentTeam>();
  for (const t of teams) for (const id of t.agent_ids) teamOf.set(id, t);
  const unassigned = all.filter((a) => !teamOf.has(a.id));

  const add = () => mutate((list) => [...list, newTeam(list)]);

  return (
    <div className={cn("space-y-3", compact && "space-y-2.5")}>
      {error && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{error}</p>
      )}

      {/* La vie d'équipe : les agents se parlent d'eux-mêmes — idées,
          challenges, relectures — et en tirent leurs leçons. */}
      <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
        <span className="min-w-0 flex-1 text-[12px]">
          <span className="font-medium">Vie d'équipe</span>
          <span className="block text-[11px] text-muted-foreground">
            {teamLife === "off" ? "Les agents ne se parlent que quand on le leur demande."
              : teamLife === "active" ? "Jusqu'à 24 initiatives par jour : idées, challenges, relectures."
              : "Jusqu'à 6 initiatives par jour : idées, challenges, relectures."}
          </span>
        </span>
        <div className="flex shrink-0 rounded-lg bg-background p-0.5 ring-1 ring-border/60">
          {([["off", "Coupée"], ["calm", "Calme"], ["active", "Active"]] as const).map(([k, label]) => (
            <button
              key={k} type="button" onClick={() => void setTeamLife(k)}
              className={cn("rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                teamLife === k ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {teams.length === 0 && (
        <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
          <UsersThreeIcon className="mx-auto h-6 w-6 text-muted-foreground/60" />
          <p className="mt-2 text-[13px] font-medium">Aucune équipe</p>
          <p className="mx-auto mt-1 max-w-xs text-[12px] leading-relaxed text-muted-foreground">
            Regroupez des agents autour d'un sujet : ils partagent un bureau dans le Live Space,
            et une room où leur parler d'un coup.
          </p>
        </div>
      )}

      {/* Une équipe complète d'une phrase, ou du catalogue : l'écran Teamz. */}
      <button
        type="button"
        onClick={() => navigate(`${location.pathname.replace(/\/(live|settings|teamz).*$/, "")}/teamz`)}
        className="flex w-full items-center gap-2.5 rounded-xl border border-border/60 bg-gradient-to-r from-[hsl(var(--primary-soft)/0.10)] to-transparent px-3 py-2.5 text-left transition-colors hover:border-[hsl(var(--primary-soft)/0.5)]"
      >
        <UsersThreeIcon className="h-4 w-4 shrink-0 text-[hsl(var(--primary-soft))]" weight="duotone" />
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium">Créer une équipe complète</span>
          <span className="block text-[11px] text-muted-foreground">Décrivez-la en une phrase, ou installez-en une du catalogue : rôles, prompts, passations, routines.</span>
        </span>
      </button>

      {teams.map((t) => (
        <TeamCard
          key={t.id} team={t} agents={all} byId={byId} teamOf={teamOf}
          dashboard={dashboard} workspaceId={workspaceId} projectId={projectId}
          compact={compact}
          machine={machineFlags?.get(t.id) ?? null}
          editing={editingTeamId === t.id}
          onEdit={onEditTeam ? () => onEditTeam(editingTeamId === t.id ? null : t.id) : undefined}
          onChange={(patch) => mutate((list) => list.map((x) => (x.id === t.id ? { ...x, ...patch } : x)))}
          onToggleAgent={(agentId) => mutate((list) => {
            const cur = list.find((x) => x.id === t.id);
            return assignAgentToTeam(list, agentId, cur?.agent_ids.includes(agentId) ? null : t.id);
          })}
          onDelete={() => {
            if (editingTeamId === t.id) onEditTeam?.(null);
            void mutate((list) => list.filter((x) => x.id !== t.id));
          }}
        />
      ))}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button" onClick={() => void add()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-muted"
        >
          <PlusIcon className="h-3.5 w-3.5" /> Nouvelle équipe
        </button>
        {onOpenLive && (
          <button
            type="button" onClick={onOpenLive}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <CubeIcon className="h-3.5 w-3.5" /> Voir dans le Live Space
          </button>
        )}
      </div>

      {all.length > 0 && (
        <p className="text-[11.5px] text-muted-foreground">
          {unassigned.length === 0
            ? "Tous les agents ont une équipe."
            : `${unassigned.length} agent${unassigned.length > 1 ? "s" : ""} sans équipe — installé${unassigned.length > 1 ? "s" : ""} en open space.`}
        </p>
      )}
    </div>
  );
}

function TeamCard({
  team, agents, byId, teamOf, dashboard, workspaceId, projectId, compact, machine, editing, onEdit,
  onChange, onToggleAgent, onDelete,
}: {
  team: AgentTeam;
  agents: LiteAgent[];
  byId: Map<string, LiteAgent>;
  teamOf: Map<string, AgentTeam>;
  dashboard: { id: string; name: string };
  workspaceId: string | null;
  projectId: string | null;
  compact?: boolean;
  /** Sa machine d'équipe (0296), si elle en a une. */
  machine: "active" | "paused" | null;
  editing: boolean;
  onEdit?: () => void;
  onChange: (patch: Partial<AgentTeam>) => void;
  onToggleAgent: (agentId: string) => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { user } = useAuth();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [gathering, setGathering] = useState(false);
  const [machineOpen, setMachineOpen] = useState(false);
  const members = team.agent_ids.map((id) => byId.get(id)).filter((a): a is LiteAgent => !!a);

  async function gather() {
    if (!workspaceId || !projectId || !members.length || gathering) return;
    setGathering(true);
    try {
      const roomId = await gatherTeam(team, dashboard, workspaceId, projectId, user?.id ?? null);
      qc.invalidateQueries({ queryKey: ["service_rooms", dashboard.id] });
      if (roomId) navigate(`/app/${workspaceSlug}/${projectSlug}/service/${dashboard.id}/room/${roomId}`);
    } finally { setGathering(false); }
  }

  return (
    <div
      className={cn(
        "rounded-xl border bg-card/60 transition-colors",
        editing ? "border-transparent ring-2" : "border-border/60",
        compact ? "p-3" : "p-4",
      )}
      style={editing ? { ["--tw-ring-color" as string]: `${team.color}99` } : undefined}
    >
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button" title="Couleur de l'équipe" aria-label="Couleur de l'équipe"
              className="h-4 w-4 shrink-0 rounded-[5px] ring-1 ring-black/10 transition-transform hover:scale-110"
              style={{ background: team.color }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="rounded-xl p-2">
            <div className="grid grid-cols-4 gap-1.5">
              {TEAM_COLORS.map((c) => (
                <button
                  key={c} type="button" onClick={() => onChange({ color: c })}
                  className={cn("flex h-7 w-7 items-center justify-center rounded-lg transition-transform hover:scale-110")}
                  style={{ background: c }}
                  aria-label={`Couleur ${c}`}
                >
                  {team.color === c && <CheckIcon className="h-3.5 w-3.5 text-white" weight="bold" />}
                </button>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        <CommitInput
          value={team.name}
          onCommit={(v) => v.trim() && v.trim() !== team.name && onChange({ name: v.trim() })}
          className="min-w-0 flex-1 text-[13.5px] font-semibold"
          placeholder="Nom de l'équipe"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Options de l'équipe" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              <DotsThreeIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="rounded-xl">
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={async () => {
                if (await confirm(`Dissoudre l'équipe « ${team.name} » ? Ses agents retournent en open space.`)) onDelete();
              }}
            >
              <TrashIcon className="mr-2 h-3.5 w-3.5" /> Dissoudre l'équipe
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <CommitInput
        value={team.focus}
        onCommit={(v) => v !== team.focus && onChange({ focus: v })}
        className="mt-1 w-full text-[12px] text-muted-foreground"
        placeholder="Sur quoi travaille-t-elle ?"
      />

      {/* Les membres : une pastille par agent. La couronne désigne l'animateur,
          celui qui répond dans la room quand personne n'est nommé. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {members.map((a) => {
          const lead = team.lead_id === a.id;
          return (
            <span
              key={a.id}
              className="group/m inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/60 py-0.5 pl-0.5 pr-1 text-[12px]"
            >
              <AgentIdentity url={a.avatar_url} seed={a.name} size={18} rounded="rounded-full" interactive={false} />
              <span className="max-w-[120px] truncate">{a.name}</span>
              <button
                type="button" onClick={() => onChange({ lead_id: lead ? null : a.id })}
                title={lead ? "Animateur de l'équipe" : "Désigner comme animateur"}
                className={cn("rounded-full p-0.5 transition-colors",
                  lead ? "text-amber-500" : "text-muted-foreground/50 opacity-0 hover:text-amber-500 group-hover/m:opacity-100")}
              >
                <CrownSimpleIcon className="h-3 w-3" weight={lead ? "fill" : "regular"} />
              </button>
              <button
                type="button" onClick={() => onToggleAgent(a.id)} title="Retirer de l'équipe"
                className="rounded-full p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </span>
          );
        })}

        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              <PlusIcon className="h-3 w-3" /> Agent
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 rounded-xl p-1.5">
            <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium text-muted-foreground">Membres de « {team.name} »</p>
            <div className="max-h-64 overflow-y-auto">
              {agents.map((a) => {
                const other = teamOf.get(a.id);
                const inTeam = other?.id === team.id;
                return (
                  <button
                    key={a.id} type="button" onClick={() => onToggleAgent(a.id)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted"
                  >
                    <span className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      inTeam ? "border-transparent text-white" : "border-border",
                    )} style={inTeam ? { background: team.color } : undefined}>
                      {inTeam && <CheckIcon className="h-3 w-3" weight="bold" />}
                    </span>
                    <AgentIdentity url={a.avatar_url} seed={a.name} size={18} rounded="rounded-md" interactive={false} />
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    {other && !inTeam && (
                      <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground" title={`Dans « ${other.name} » — le cocher l'y retire`}>
                        <span className="h-2 w-2 rounded-[3px]" style={{ background: other.color }} />
                        <span className="max-w-[70px] truncate">{other.name}</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button
          type="button" onClick={() => void gather()} disabled={!members.length || gathering}
          title={members.length ? "Ouvrir une room avec toute l'équipe" : "Ajoutez d'abord des agents"}
          className="inline-flex items-center gap-1.5 rounded-lg bg-muted/70 px-2.5 py-1.5 text-[12px] font-medium transition-colors hover:bg-muted disabled:opacity-50"
        >
          {gathering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChatsCircleIcon className="h-3.5 w-3.5" />}
          Réunir l'équipe
        </button>
        <button
          type="button" onClick={() => setMachineOpen(true)}
          title={machine === "active" ? "La machine partagée de l'équipe" : machine === "paused" ? "Machine en pause" : "Donner une machine à l'équipe"}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <TerminalWindowIcon className="h-3.5 w-3.5" />
          Machine
          {machine && (
            <span className={cn("h-1.5 w-1.5 rounded-full", machine === "active" ? "bg-emerald-500" : "bg-amber-500")} />
          )}
        </button>
        {onEdit && (
          <button
            type="button" onClick={onEdit}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] transition-colors",
              editing ? "bg-primary/15 font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <CursorClickIcon className="h-3.5 w-3.5" />
            {editing ? "Terminer" : "Choisir dans la scène"}
          </button>
        )}
      </div>
      <TeamMachineDialog
        open={machineOpen} onOpenChange={setMachineOpen}
        dashboardId={dashboard.id} team={team} agents={agents}
      />
    </div>
  );
}

/** Un texte qui s'enregistre à la sortie du champ — ⏎ valide, Échap annule. */
function CommitInput({ value, onCommit, className, placeholder }: {
  value: string; onCommit: (v: string) => void; className?: string; placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <input
      value={draft} placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (cancelled.current) { cancelled.current = false; return; }
        onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { cancelled.current = true; setDraft(value); e.currentTarget.blur(); }
      }}
      className={cn(
        "rounded-md bg-transparent px-1 py-0.5 outline-none transition-colors placeholder:text-muted-foreground/50 hover:bg-muted/50 focus:bg-muted/60",
        className,
      )}
    />
  );
}

