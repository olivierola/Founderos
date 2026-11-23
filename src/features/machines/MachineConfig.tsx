import { useState } from "react";
import {
  FloppyDiskIcon, PauseIcon, PlayIcon, TrashIcon, ArrowsClockwiseIcon, KeyIcon, PackageIcon, CircleNotchIcon as Loader2,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ToastProvider";
import { useConfirm } from "@/components/ConfirmProvider";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/features/tracker/pickers";
import { fleetApi, formatAge, formatKb, KIND_LABEL, useRefreshFleet, type FleetMachine, type MachineKind } from "./api";
import { KIND_ICON } from "./kinds";

export function MachineConfig({ machine: m, dashboardId, onDeleted }: { machine: FleetMachine; dashboardId: string; onDeleted: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const refresh = useRefreshFleet(dashboardId);
  const [name, setName] = useState(m.name);
  const [description, setDescription] = useState(m.description ?? "");
  const [kind, setKind] = useState<MachineKind>(m.kind);
  const [url, setUrl] = useState(m.url ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  // Créée par la plateforme (0311) : son adresse et son jeton lui appartiennent.
  const managed = !!m.managed_by;
  const fixedUrl = managed;
  const dirty = name !== m.name || description !== (m.description ?? "") || kind !== m.kind || (!fixedUrl && url !== (m.url ?? ""));
  const info = m.info ?? {};

  const run = async (key: string, op: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await op();
      if (done) toast.success(done);
      await refresh();
    } catch (e) {
      toast.error("Action impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = () => run("save", () => fleetApi.update(m.id, {
    name: name.trim(), description: description.trim(), kind, ...(fixedUrl ? {} : { url: url.trim() }),
  }), "Machine enregistrée");

  const probe = () => run("probe", async () => {
    const r = await fleetApi.probe(m.id);
    if (r.probe.reachable) toast.success("Machine joignable", r.probe.latency_ms != null ? `${r.probe.latency_ms} ms` : undefined);
    else toast.error("Machine injoignable", r.probe.error);
  });

  const pause = async () => {
    if (m.status === "active") {
      const ok = await confirm({
        title: "Mettre la machine en pause ?",
        description: "Les agents perdent leurs outils de machine et leurs processus s'arrêtent. Les fichiers restent.",
        confirmText: "Mettre en pause",
      });
      if (!ok) return;
    }
    await run("status", () => fleetApi.update(m.id, { status: m.status === "active" ? "paused" : "active" }),
      m.status === "active" ? "Machine en pause" : "Machine relancée");
  };

  const removeManaged = async (wipe: boolean) => {
    setBusy("delete");
    try {
      await fleetApi.remove(m.id, wipe ? "all" : true);
      toast.success("Machine supprimée", wipe ? "Conteneur et dossiers effacés." : "Conteneur supprimé, dossiers gardés.");
      setRemoving(false);
      await refresh();
      onDeleted();
    } catch (e) {
      toast.error("Suppression impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (managed) { setRemoving(true); return; }
    const ok = await confirm({
      title: `Supprimer « ${m.name} » ?`,
      description: "La machine sort du parc. Ses fichiers restent sur le poste lui-même ; rien n'y est effacé.",
      confirmText: "Supprimer",
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await fleetApi.remove(m.id);
      toast.success("Machine supprimée");
      await refresh();
      onDeleted();
    } catch (e) {
      toast.error("Suppression impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]">
      <div className="space-y-5">
        <Card title="Identité">
          <Field label="Nom"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Description">
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="À quoi elle sert, ce qu'elle a d'installé" />
          </Field>
          <Field label="Type">
            <div className="flex flex-wrap gap-1.5">
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
          </Field>
          <Field label="Adresse">
            {managed ? (
              <p className="text-[13px] text-muted-foreground">
                Créée par la plateforme : conteneur <span className="font-mono text-foreground">{m.managed_ref ?? "en préparation"}</span>
                {m.url && <>, joint sur <span className="font-mono text-foreground">{m.url}</span></>}.
              </p>
            ) : (
              <Input className="font-mono text-[13px]" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://ma-machine.exemple.com" />
            )}
          </Field>
          <div className="flex justify-end">
            <Button size="sm" onClick={save} disabled={!dirty || busy === "save" || !name.trim()}>
              {busy === "save" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <FloppyDiskIcon className="mr-1.5 h-3.5 w-3.5" />} Enregistrer
            </Button>
          </div>
        </Card>

        <Card title="Accès">
          <div className="flex items-start gap-3">
            <KeyIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{managed ? "Jeton généré à la création" : m.has_token ? "Jeton propre à cette machine" : "Aucun jeton : la machine ne répondra pas"}</div>
              <p className="text-[12px] text-muted-foreground">La clé qui signe chaque appel. Chiffrée, jamais réaffichée, jamais donnée aux agents.</p>
              {!managed && <div className="mt-2 flex gap-2">
                <Input type="password" autoComplete="off" className="h-8 font-mono text-[12.5px]" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Nouveau jeton (32 caractères au moins)" />
                <Button size="sm" variant="outline" disabled={token.trim().length < 32 || busy === "token"}
                  onClick={() => run("token", async () => { await fleetApi.update(m.id, { token: token.trim() }); setToken(""); }, "Jeton enregistré")}>Poser</Button>
                {m.has_token && (
                  <Button size="sm" variant="ghost" disabled={busy === "token"}
                    onClick={() => run("token", () => fleetApi.update(m.id, { token: null }), "Jeton retiré")}>Retirer</Button>
                )}
              </div>}
            </div>
          </div>
          <SwitchRow
            icon={PackageIcon}
            label="Paquets système"
            desc={managed
              ? "Les agents peuvent demander des paquets apt, installés pour toute la machine. Changer ce réglage relance le conteneur ; les fichiers restent."
              : "Les agents peuvent demander des paquets apt, installés pour toute la machine. Il faut aussi MACHINE_ALLOW_APT=1 sur le poste."}
            checked={m.allow_system_packages}
            disabled={busy === "apt"}
            onChange={(v) => run("apt", () => fleetApi.update(m.id, { allow_system_packages: v }), managed ? "Machine relancée" : undefined)}
          />
        </Card>
      </div>

      <div className="space-y-5">
        <Card title="État">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
            <Dt>Version</Dt><Dd mono>{info.version ? `team-machine ${info.version}` : "–"}</Dd>
            <Dt>Hôte</Dt><Dd mono>{info.hostname ?? "–"}</Dd>
            <Dt>Système</Dt><Dd mono>{info.platform ? `${info.platform} ${info.arch ?? ""}` : "–"}</Dd>
            <Dt>Navigateur</Dt><Dd>{info.browser ? "Chromium, un profil par agent" : info.version ? "absent (image antérieure à 0.3.0)" : "–"}</Dd>
            <Dt>Processeurs</Dt><Dd>{info.cpus ?? "–"}</Dd>
            <Dt>Mémoire</Dt><Dd>{info.mem ? `${formatKb(info.mem.total_kb)} (${formatKb(info.mem.free_kb)} libres)` : "–"}</Dd>
            <Dt>Disque</Dt><Dd>{info.disk ? `${formatKb(info.disk.total_kb)} (${formatKb(info.disk.free_kb)} libres)` : "–"}</Dd>
            <Dt>Allumée depuis</Dt><Dd>{formatAge(info.uptime_s)}</Dd>
            <Dt>Dernier contact</Dt><Dd>{m.last_seen_at ? formatRelative(m.last_seen_at) : "jamais"}</Dd>
            {info.limits && (
              <>
                <Dt>Limites</Dt>
                <Dd wrap>{info.limits.procs_per_agent} processus par agent · fichiers de {info.limits.file_mb} Mo · commandes de {info.limits.exec_max_s} s · {info.limits.jobs_per_agent} jobs de {info.limits.job_max_h} h</Dd>
              </>
            )}
          </dl>
          {m.last_error && <p className="rounded-md bg-red-500/10 px-2.5 py-1.5 text-[12px] text-red-700 dark:text-red-400">{m.last_error}</p>}
          {info.dry && <p className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[12px] text-amber-700 dark:text-amber-400">Mode test (MACHINE_DRY_RUN) : rien n'y est isolé.</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={probe} disabled={busy === "probe"}>
              {busy === "probe" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ArrowsClockwiseIcon className="mr-1.5 h-3.5 w-3.5" />} Tester la connexion
            </Button>
            <Button size="sm" variant="outline" onClick={pause} disabled={busy === "status"}>
              {m.status === "active" ? <><PauseIcon className="mr-1.5 h-3.5 w-3.5" /> Mettre en pause</> : <><PlayIcon className="mr-1.5 h-3.5 w-3.5" /> Relancer</>}
            </Button>
          </div>
        </Card>

        <Card title="Zone de danger" tone="danger">
          <p className="text-[13px] text-muted-foreground">
            Retirer la machine du parc. Elle doit d'abord être retirée des équipes et des agents qui l'utilisent ({m.assignments}).
          </p>
          <div>
            <Button size="sm" variant="destructive" onClick={remove} disabled={busy === "delete" || m.assignments > 0}>
              <TrashIcon className="mr-1.5 h-3.5 w-3.5" /> Supprimer la machine
            </Button>
          </div>
        </Card>
      </div>
      {managed && (
        <RemoveManagedDialog
          open={removing} onOpenChange={setRemoving} name={m.name} busy={busy === "delete"} onConfirm={removeManaged}
        />
      )}
    </div>
  );
}

/** Supprimer une machine créée par la plateforme : le conteneur part ; ses dossiers, au choix. */
function RemoveManagedDialog({ open, onOpenChange, name, busy, onConfirm }: {
  open: boolean; onOpenChange: (v: boolean) => void; name: string; busy: boolean; onConfirm: (wipe: boolean) => void;
}) {
  const [wipe, setWipe] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setWipe(false); onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Supprimer « {name} » ?</DialogTitle>
          <DialogDescription>La machine sort du parc et son conteneur est arrêté puis supprimé.</DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3">
          <Checkbox checked={wipe} onCheckedChange={(v) => setWipe(v === true)} className="mt-0.5" />
          <span>
            <span className="block text-[13px] font-medium">Effacer aussi ses fichiers</span>
            <span className="block text-[12px] text-muted-foreground">Les dossiers des équipes et des agents sur cette machine. Sans cette case, ils restent dans les volumes Docker.</span>
          </span>
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Annuler</Button>
          <Button variant="destructive" onClick={() => onConfirm(wipe)} disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <TrashIcon className="mr-1.5 h-3.5 w-3.5" />} Supprimer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Card({ title, tone, children }: { title: string; tone?: "danger"; children: React.ReactNode }) {
  return (
    <section className={cn("space-y-4 rounded-xl border bg-card p-5", tone === "danger" ? "border-red-500/30" : "border-border")}>
      <h2 className={cn("text-[14px] font-semibold tracking-tight", tone === "danger" && "text-red-600 dark:text-red-400")}>{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const Dt = ({ children }: { children: React.ReactNode }) => <dt className="text-muted-foreground">{children}</dt>;
const Dd = ({ children, mono, wrap }: { children: React.ReactNode; mono?: boolean; wrap?: boolean }) => (
  <dd className={cn("min-w-0", wrap ? "leading-relaxed" : "truncate", mono && "font-mono text-[12px]")}>{children}</dd>
);

function SwitchRow({ icon: Icon, label, desc, checked, disabled, onChange }: {
  icon: typeof PackageIcon; label: string; desc: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        <p className="text-[12px] text-muted-foreground">{desc}</p>
      </div>
      <button
        type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50", checked ? "bg-primary" : "bg-muted")}
      >
        <span className={cn("absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform", checked ? "translate-x-5" : "translate-x-0")} />
      </button>
    </div>
  );
}
