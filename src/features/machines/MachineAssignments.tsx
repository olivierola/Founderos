import { useState } from "react";
import { UsersThreeIcon, UserIcon, ArrowRightIcon, CircleNotchIcon as Loader2, WarningCircleIcon } from "@phosphor-icons/react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AgentIdentity } from "@/components/AgentIdentity";
import { useToast } from "@/components/ToastProvider";
import { useConfirm } from "@/components/ConfirmProvider";
import { cn } from "@/lib/utils";
import { fleetApi, HEALTH_META, machineHealth, useRefreshFleet, type Assignment, type Fleet } from "./api";

/**
 * Qui travaille sur quelle machine. Une équipe reçoit une machine pour tous
 * ses agents (dossier commun, dossiers protégés) ; un agent peut aussi avoir
 * la sienne, qui passe alors avant celle de son équipe.
 *
 * Changer de machine ne déplace pas les fichiers : l'équipe repart d'un
 * dossier vide sur la nouvelle, l'ancienne garde les siens.
 */
export function MachineAssignments({ dashboardId, fleet }: { dashboardId: string; fleet: Fleet }) {
  const toast = useToast();
  const confirm = useConfirm();
  const refresh = useRefreshFleet(dashboardId);
  const [busy, setBusy] = useState<string | null>(null);
  const live = fleet.machines.filter((m) => m.status === "active");

  const rowOf = (teamId: string) => fleet.assignments.find((a) => a.team_id === teamId) ?? null;
  const current = (a: Assignment | null) => (a && a.status === "active" ? a.machine_id ?? "platform-legacy" : "none");
  const machineName = (id: string | null) => fleet.machines.find((m) => m.id === id)?.name ?? "Machine de la plateforme";

  const assign = async (type: "team" | "agent", id: string, teamId: string, value: string) => {
    const row = rowOf(teamId);
    const was = current(row);
    if (value === was) return;
    if (was !== "none" && value !== "none") {
      const ok = await confirm({
        title: "Changer de machine ?",
        description: "Les fichiers restent sur l'ancienne machine : le travail repart d'un dossier vide sur la nouvelle. Les processus en cours s'arrêtent.",
        confirmText: "Changer", destructive: false,
      });
      if (!ok) return;
    }
    setBusy(teamId);
    try {
      const r = await fleetApi.assign(dashboardId, { type, id }, value === "none" ? null : value);
      toast.success(value === "none" ? "Machine retirée" : r.moved ? "Machine changée" : "Machine attribuée",
        value === "none" ? "Les fichiers restent sur la machine." : undefined);
      await refresh();
    } catch (e) {
      toast.error("Attribution impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const picker = (type: "team" | "agent", id: string, teamId: string, noneLabel = "Aucune machine") => {
    const row = rowOf(teamId);
    const value = current(row);
    return (
      <div className="flex shrink-0 items-center gap-2">
        {busy === teamId && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <Select value={value} onValueChange={(v) => void assign(type, id, teamId, v)} disabled={busy === teamId || (!live.length && value === "none")}>
          <SelectTrigger className="h-8 w-[230px] rounded-md text-[13px]">
            <SelectValue placeholder="Aucune machine" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{noneLabel}</SelectItem>
            {value === "platform-legacy" && <SelectItem value="platform-legacy">Machine de la plateforme</SelectItem>}
            {live.map((m) => {
              const h = HEALTH_META[machineHealth(m)];
              return (
                <SelectItem key={m.id} value={m.id}>
                  <span className="flex items-center gap-2"><span className={cn("h-1.5 w-1.5 rounded-full", h.dot)} />{m.name}</span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {!live.length && (
        <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-[13px] text-muted-foreground">
          <WarningCircleIcon className="mt-0.5 h-4 w-4 shrink-0" /> Aucune machine active : ajoutez-en une depuis la vue d'ensemble.
        </p>
      )}

      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <UsersThreeIcon className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-[14px] font-semibold tracking-tight">Équipes</h2>
          <span className="text-[12px] text-muted-foreground">· une machine pour toute l'équipe, avec un dossier commun</span>
        </div>
        {fleet.teams.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">Aucune équipe dans ce service.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {fleet.teams.map((t) => {
              const row = rowOf(t.id);
              const members = t.agent_ids.map((id) => fleet.agents.find((a) => a.id === id)).filter(Boolean) as Fleet["agents"];
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium">{t.name}</div>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="flex items-center">
                        {members.slice(0, 6).map((m) => (
                          <span key={m.id} className="-ml-1.5 rounded-full bg-card ring-2 ring-card first:ml-0" title={m.name}>
                            <AgentIdentity url={m.avatar_url} seed={m.name} size={20} interactive={false} />
                          </span>
                        ))}
                      </div>
                      <span className="text-[12px] text-muted-foreground">{members.length} agent{members.length > 1 ? "s" : ""}</span>
                      {row?.status === "paused" && row.machine_id && (
                        <span className="text-[12px] text-amber-600 dark:text-amber-400">retirée de {machineName(row.machine_id)}</span>
                      )}
                    </div>
                    {row?.last_error && row.status === "active" && (
                      <p className="mt-1 truncate text-[12px] text-red-600 dark:text-red-400" title={row.last_error}>{row.last_error}</p>
                    )}
                  </div>
                  {picker("team", t.id, t.id)}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <UserIcon className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-[14px] font-semibold tracking-tight">Agents</h2>
          <span className="text-[12px] text-muted-foreground">· une machine à lui, qui passe avant celle de son équipe</span>
        </div>
        {fleet.agents.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">Aucun agent dans ce service.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {fleet.agents.map((a) => {
              const soloId = `agent-${a.id}`;
              const own = rowOf(soloId);
              const viaTeam = !own || own.status !== "active"
                ? a.teams.map((tid) => ({ team: fleet.teams.find((t) => t.id === tid), row: rowOf(tid) }))
                  .find((x) => x.row?.status === "active")
                : null;
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <AgentIdentity url={a.avatar_url} seed={a.name} size={28} interactive={false} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium">{a.name}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                      {own?.status === "active" ? (
                        <>Travaille sur sa propre machine</>
                      ) : viaTeam?.team ? (
                        <>Via {viaTeam.team.name} <ArrowRightIcon className="h-3 w-3" /> {machineName(viaTeam.row!.machine_id)}</>
                      ) : (
                        <>Pas de machine</>
                      )}
                    </div>
                  </div>
                  {picker("agent", a.id, soloId, a.teams.length ? "Celle de son équipe" : "Aucune machine")}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
