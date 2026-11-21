import { useEffect, useMemo, useState } from "react";
import {
  FolderIcon, FileTextIcon, LinkSimpleIcon, LockSimpleIcon, HouseIcon, UsersThreeIcon, CaretRightIcon, ArrowsClockwiseIcon,
  EyeIcon, CircleNotchIcon as Loader2, WarningCircleIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { AgentIdentity } from "@/components/AgentIdentity";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/features/tracker/pickers";
import { fleetApi, formatBytes, type FileEntry, type FileRead, type Fleet, type FleetMachine, type FilesWhere } from "./api";
import { ownerLabel } from "./MachineActivity";

/**
 * Le système de fichiers d'une machine, VU PAR UN AGENT : on lit ce que cet
 * agent peut lire, avec ses secrets, et le noyau tranche. Changer d'agent
 * change ce qu'on voit — son dossier perso, les dossiers protégés dont il est
 * membre. Lecture seule ; chaque fichier ouvert par un humain est journalisé.
 */
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
const mimeOf = (p: string) => (/\.png$/i.test(p) ? "image/png" : /\.gif$/i.test(p) ? "image/gif" : /\.webp$/i.test(p) ? "image/webp" : "image/jpeg");

export function MachineFiles({ machine, fleet }: { machine: FleetMachine; fleet: Fleet }) {
  // Les regards possibles : chaque agent de chaque attribution active de cette machine.
  const viewers = useMemo(() => {
    const out: Array<{ teamId: string; agentId: string; name: string; avatar: string | null; group: string }> = [];
    for (const a of fleet.assignments.filter((x) => x.machine_id === machine.id && x.status === "active")) {
      const ids = a.scope === "agent" && a.agent_id ? [a.agent_id] : fleet.teams.find((t) => t.id === a.team_id)?.agent_ids ?? [];
      for (const id of ids) {
        const ag = fleet.agents.find((x) => x.id === id);
        if (ag) out.push({ teamId: a.team_id, agentId: id, name: ag.name, avatar: ag.avatar_url, group: a.scope === "agent" ? "sa machine" : ownerLabel(fleet, a.team_id) });
      }
    }
    return out;
  }, [fleet, machine.id]);

  const [viewer, setViewer] = useState(0);
  const v = viewers[viewer] ?? null;
  const [path, setPath] = useState("~");
  const [list, setList] = useState<{ path: string; entries: FileEntry[]; truncated: boolean } | null>(null);
  const [where, setWhere] = useState<FilesWhere | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<FileRead["result"] | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const load = async (p: string) => {
    if (!v) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fleetApi.list(v.teamId, v.agentId, p, showHidden);
      setList(r.result);
      setWhere(r.where);
      setPath(r.result.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setFile(null); void load("~"); }, [v?.teamId, v?.agentId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (list) void load(path); }, [showHidden]);

  const openFile = async (p: string) => {
    if (!v) return;
    setFileLoading(true);
    try {
      setFile((await fleetApi.read(v.teamId, v.agentId, p, IMAGE_RE.test(p))).result);
    } catch (e) {
      setFile({ path: p, size: 0, content: `Lecture impossible : ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setFileLoading(false);
    }
  };

  if (!viewers.length) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <FolderIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm font-medium">Aucun agent sur cette machine</p>
        <p className="mt-1 text-sm text-muted-foreground">Attribuez-la à une équipe ou à un agent : ses fichiers se liront par leurs yeux.</p>
      </div>
    );
  }

  const join = (dir: string, rel: string) => `${dir.replace(/\/+$/, "")}/${rel}`;
  const crumbs = path.split("/").filter(Boolean);
  const entries = [...(list?.entries ?? [])].sort((a, b) =>
    (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || a.path.localeCompare(b.path));
  const places: Array<{ label: string; icon: typeof HouseIcon; path: string | null }> = where ? [
    { label: "Dossier perso", icon: HouseIcon, path: where.home },
    ...(!where.solo ? [{ label: "Commun", icon: UsersThreeIcon, path: where.shared }] : []),
    ...where.folders.map((f) => ({ label: f.name, icon: LockSimpleIcon, path: f.path })),
    { label: where.solo ? "Racine" : "Racine de l'équipe", icon: FolderIcon, path: where.team_dir },
  ] : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><EyeIcon className="h-3.5 w-3.5" /> Vu par</span>
        <div className="flex max-w-full gap-1 overflow-x-auto scrollbar-hide">
          {viewers.map((x, i) => (
            <button
              key={`${x.teamId}:${x.agentId}`}
              onClick={() => setViewer(i)}
              title={x.group}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[12.5px] transition-colors",
                i === viewer ? "border-primary bg-primary/5 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <AgentIdentity url={x.avatar} seed={x.name} size={18} interactive={false} />
              {x.name}
              <span className="text-[11px] text-muted-foreground">· {x.group}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]">
        <section className="flex min-h-[420px] min-w-0 flex-col rounded-xl border border-border bg-card">
          {places.length > 0 && <div className="flex flex-wrap gap-1 border-b border-border/60 px-3 py-2">
            {places.map((p) => p.path && (
              <button key={p.path} onClick={() => void load(p.path!)}
                className={cn("flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] transition-colors",
                  path === p.path ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
                <p.icon className="h-3.5 w-3.5" /> {p.label}
              </button>
            ))}
          </div>}
          <div className="flex items-center gap-2 px-3 py-2">
            <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto font-mono text-[12px] scrollbar-hide">
              <button className="shrink-0 rounded px-1 text-muted-foreground hover:text-foreground" onClick={() => void load("/")}>/</button>
              {crumbs.map((c, i) => (
                <span key={i} className="flex shrink-0 items-center gap-0.5">
                  {i > 0 && <CaretRightIcon className="h-3 w-3 text-muted-foreground/60" />}
                  <button className={cn("rounded px-1", i === crumbs.length - 1 ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                    onClick={() => void load(`/${crumbs.slice(0, i + 1).join("/")}`)}>{c}</button>
                </span>
              ))}
            </nav>
            <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="h-3.5 w-3.5 accent-[hsl(var(--primary))]" />
              cachés
            </label>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => void load(path)} disabled={loading} title="Rafraîchir">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowsClockwiseIcon className="h-3.5 w-3.5" />}
            </Button>
          </div>
          {error ? (
            <p className="m-3 flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[12.5px] text-red-700 dark:text-red-400">
              <WarningCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
              {/access_denied|EACCES|permission/i.test(error) ? `${v?.name} n'a pas accès à ce dossier.` : error}
            </p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto pb-2 scrollbar-hide">
              {path !== "/" && (
                <li>
                  <button className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted/50"
                    onClick={() => void load(path.replace(/\/[^/]+\/?$/, "") || "/")}>
                    <FolderIcon className="h-4 w-4" /> ..
                  </button>
                </li>
              )}
              {entries.map((e) => {
                const Icon = e.type === "dir" ? FolderIcon : e.type === "link" ? LinkSimpleIcon : FileTextIcon;
                const full = join(path, e.path);
                return (
                  <li key={e.path}>
                    <button
                      disabled={!!e.error}
                      onClick={() => (e.type === "dir" ? void load(full) : void openFile(full))}
                      className={cn("flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-muted/50 disabled:opacity-50",
                        file?.path === full && "bg-primary/5")}
                    >
                      <Icon weight={e.type === "dir" ? "fill" : "regular"} className={cn("h-4 w-4 shrink-0", e.type === "dir" ? "text-primary/70" : "text-muted-foreground")} />
                      <span className="min-w-0 flex-1 truncate">{e.path}</span>
                      {e.error ? <span className="shrink-0 text-[11.5px] text-red-600 dark:text-red-400">{e.error}</span> : (
                        <>
                          <span className="hidden w-20 shrink-0 text-right font-mono text-[11.5px] text-muted-foreground sm:block">{e.type === "file" ? formatBytes(e.size) : ""}</span>
                          <span className="hidden w-24 shrink-0 truncate text-right text-[11.5px] text-muted-foreground md:block" title={`${e.owner}:${e.group} ${e.mode}`}>{e.owner}</span>
                          <span className="hidden w-24 shrink-0 text-right text-[11.5px] text-muted-foreground lg:block">{e.modified ? formatRelative(e.modified) : ""}</span>
                        </>
                      )}
                    </button>
                  </li>
                );
              })}
              {!loading && entries.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted-foreground">Dossier vide.</li>}
              {list?.truncated && <li className="px-3 py-2 text-[12px] text-muted-foreground">Liste tronquée à 400 entrées.</li>}
            </ul>
          )}
        </section>

        <section className="flex min-h-[420px] min-w-0 flex-col rounded-xl border border-border bg-card">
          {fileLoading ? (
            <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : !file ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <FileTextIcon className="h-7 w-7 text-muted-foreground/40" />
              <p className="text-[13px] text-muted-foreground">Choisissez un fichier pour le lire.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{file.path}</span>
                <span className="shrink-0 text-[11.5px] text-muted-foreground">
                  {formatBytes(file.size)}{file.total_lines ? ` · ${file.total_lines} lignes` : ""}
                </span>
              </div>
              {file.base64 ? (
                <div className="min-h-0 flex-1 overflow-auto bg-muted/40 p-4 scrollbar-hide">
                  <img src={`data:${mimeOf(file.path)};base64,${file.base64}`} alt={file.path} className="mx-auto max-w-full rounded-md border border-border" />
                </div>
              ) : file.binary ? (
                <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">Fichier binaire : pas d'aperçu.</p>
              ) : (
                <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-[12px] leading-relaxed scrollbar-hide">{file.content}</pre>
              )}
              {file.truncated && <p className="border-t border-border/60 px-4 py-2 text-[12px] text-muted-foreground">Aperçu tronqué.</p>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
