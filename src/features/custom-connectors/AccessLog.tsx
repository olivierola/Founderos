// Le journal d'accès aux outils internes : chaque appel, autorisé, approuvé,
// refusé ou en erreur. En ajout seul et chaîné par empreinte SHA-256 : la
// vérification rejoue la chaîne et dit si une ligne a été modifiée ou retirée.
import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ShieldCheckIcon as ShieldCheck, DownloadSimpleIcon as Download, CircleNotchIcon as Loader2, ListMagnifyingGlassIcon as ListSearch,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { useToast } from "@/components/ToastProvider";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { type ConnectorCall, type CustomConnector, qk } from "./api";
import { DECISION_META, Pill, RISK_META, inputCls, selectCls } from "./ui";

const PAGE = 200;

export function AccessLog({ workspaceId, connectors }: { workspaceId: string | null; connectors: CustomConnector[] }) {
  const toast = useToast();
  const [connector, setConnector] = useState("");
  const [decision, setDecision] = useState("");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<number | null>(null);
  const [verifying, setVerifying] = useState(false);

  const { data: calls, isLoading } = useQuery({
    queryKey: [...qk.calls(workspaceId), connector, decision, limit],
    enabled: !!workspaceId,
    refetchInterval: 20_000,
    queryFn: async () => {
      let q = supabase.from("custom_connector_calls").select("*").eq("workspace_id", workspaceId!)
        .order("seq", { ascending: false }).limit(limit);
      if (connector) q = q.eq("connector_id", connector);
      if (decision) q = q.eq("decision", decision);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ConnectorCall[];
    },
  });

  const { data: people } = useQuery({
    queryKey: ["ccx_people", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase.rpc("emails_for_workspace", { p_workspace: workspaceId });
      const rows = (Array.isArray(data) ? data : []) as Array<{ id: string; email: string }>;
      return new Map(rows.map((r) => [r.id, r.email]));
    },
  });

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (calls ?? []).filter((c) => !s || [c.agent_name, c.operation, c.target, c.connector_name, c.identity, c.error]
      .some((v) => (v ?? "").toLowerCase().includes(s)));
  }, [calls, search]);

  const who = (c: ConnectorCall) =>
    c.agent_name ?? (c.actor_user_id ? people?.get(c.actor_user_id) ?? "une personne" : "système");

  async function verify() {
    setVerifying(true);
    const { data, error } = await supabase.rpc("ccx_verify_chain", { p_workspace: workspaceId });
    setVerifying(false);
    const r = (Array.isArray(data) ? data[0] : data) as { checked: number; ok: boolean; broken_seq: number | null } | null;
    if (error || !r) { toast.error("Vérification impossible", error?.message); return; }
    if (r.ok) toast.success("Journal intègre", `${r.checked} appel(s) vérifié(s), aucune ligne modifiée ni retirée.`);
    else toast.error("Chaîne rompue", `L'appel n° ${r.broken_seq} ne correspond plus à son empreinte : une ligne a été modifiée ou retirée avant lui.`);
  }

  function exportCsv() {
    const head = ["date", "source", "collaborateur_ou_personne", "outil", "version", "operation", "methode", "cible", "transport", "profil", "identite", "decision", "risque", "http", "duree_ms", "octets", "masques", "erreur", "approbation", "run", "empreinte"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [head.join(","), ...rows.map((c) => [
      c.created_at, c.source, who(c), c.connector_name, c.connector_version, c.operation, c.method, c.target, c.transport,
      c.credential_label, c.identity, c.decision, c.risk, c.status_code, c.duration_ms, c.response_bytes, c.redactions, c.error,
      c.approval_id, c.run_id, c.hash,
    ].map(esc).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `journal-outils-internes-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input className={cn(inputCls, "max-w-xs")} placeholder="Collaborateur, opération, chemin…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className={cn(selectCls, "w-auto")} value={connector} onChange={(e) => setConnector(e.target.value)}>
          <option value="">Tous les outils</option>
          {connectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className={cn(selectCls, "w-auto")} value={decision} onChange={(e) => setDecision(e.target.value)}>
          <option value="">Toutes les décisions</option>
          {Object.entries(DECISION_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={verify} disabled={verifying || !workspaceId}>
            {verifying ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1 h-3.5 w-3.5" />} Vérifier l'intégrité
          </Button>
          <Button size="sm" variant="ghost" onClick={exportCsv} disabled={!rows.length}><Download className="mr-1 h-3.5 w-3.5" /> CSV</Button>
        </div>
      </div>

      {isLoading ? (
        <EmptyState icon={Loader2} title="Chargement du journal…" />
      ) : rows.length === 0 ? (
        <EmptyState icon={ListSearch} title="Aucun appel" description="Chaque appel d'un collaborateur, chaque essai et chaque refus s'inscrira ici." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[860px] text-left text-xs">
            <thead className="border-b border-border bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Quand</th>
                <th className="px-3 py-2 font-medium">Qui</th>
                <th className="px-3 py-2 font-medium">Outil · opération</th>
                <th className="px-3 py-2 font-medium">Cible</th>
                <th className="px-3 py-2 font-medium">Décision</th>
                <th className="px-3 py-2 text-right font-medium">HTTP</th>
                <th className="px-3 py-2 text-right font-medium">Durée</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <Fragment key={c.seq}>
                  <tr onClick={() => setOpen(open === c.seq ? null : c.seq)}
                    className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-secondary/30">
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {new Date(c.created_at).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </td>
                    <td className="px-3 py-2">
                      <span className="font-medium">{who(c)}</span>
                      {c.source !== "collaborator" && <span className="ml-1 text-[10px] text-muted-foreground">({c.source === "test" ? "essai" : c.source === "approval" ? "après approbation" : c.source})</span>}
                    </td>
                    <td className="px-3 py-2">
                      <span>{c.connector_name ?? "?"}</span> · <span className="font-mono">{c.operation}</span>
                      {c.risk && c.risk !== "read" && <Pill tone={RISK_META[c.risk]?.tone ?? "muted"} className="ml-1.5">{RISK_META[c.risk]?.label ?? c.risk}</Pill>}
                    </td>
                    <td className="max-w-[240px] truncate px-3 py-2 font-mono text-[11px] text-muted-foreground">{c.method} {c.target}</td>
                    <td className="px-3 py-2"><Pill tone={DECISION_META[c.decision].tone}>{DECISION_META[c.decision].label}</Pill></td>
                    <td className="px-3 py-2 text-right font-mono">{c.status_code ?? "-"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-muted-foreground">{c.duration_ms != null ? `${c.duration_ms} ms` : "-"}</td>
                  </tr>
                  {open === c.seq && (
                    <tr className="border-b border-border/60 bg-muted/20">
                      <td colSpan={7} className="px-4 py-3">
                        <dl className="grid gap-x-6 gap-y-1.5 text-[11px] sm:grid-cols-2">
                          <Detail k="Profil d'identifiants" v={c.credential_label} />
                          <Detail k="Identité vue par l'outil" v={c.identity} />
                          <Detail k="Transport" v={c.transport === "relay" ? "Relais" : c.transport === "direct" ? "Direct" : c.transport} />
                          <Detail k="Version du connecteur" v={c.connector_version} />
                          <Detail k="Valeurs masquées" v={c.redactions} />
                          <Detail k="Taille de la réponse" v={c.response_bytes != null ? `${c.response_bytes} octets` : null} />
                          <Detail k="Approbation" v={c.approval_id} mono />
                          <Detail k="Run" v={c.run_id} mono />
                          <Detail k="X-Request-Id envoyé" v={c.id} mono />
                          <Detail k="Empreinte" v={c.hash} mono />
                          {c.error && <div className="sm:col-span-2"><Detail k="Motif" v={c.error} /></div>}
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(calls?.length ?? 0) >= limit && (
        <div className="text-center"><Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>Charger plus</Button></div>
      )}
    </div>
  );
}

function Detail({ k, v, mono }: { k: string; v: unknown; mono?: boolean }) {
  if (v === null || v === undefined || v === "") return null;
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{k}</dt>
      <dd className={cn("min-w-0 break-all", mono && "font-mono text-[10px]")}>{String(v)}</dd>
    </div>
  );
}
