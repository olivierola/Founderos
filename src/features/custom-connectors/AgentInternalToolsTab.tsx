// Les outils internes confiés à UN collaborateur : lequel, avec quel profil
// d'identifiants, et quelles opérations. Le moindre privilège se règle ici :
// un collaborateur d'astreinte lit Argo CD, seul celui des mises en production
// reçoit sync et rollback.
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WrenchIcon as Wrench, ArrowSquareOutIcon as ExternalLink, CaretDownIcon as ChevronDown, CaretRightIcon as ChevronRight } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ToastProvider";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { type CustomConnector, normalizeOperations, normalizePolicy, useConnectors, useCredentials } from "./api";
import { Pill, RISK_META, selectCls } from "./ui";

interface AgentLike { id: string; name: string; project_id: string; service_dashboard_id?: string | null }
interface ToolRow { id: string; config: { connector_id?: string; operations?: string[]; credential_id?: string | null; slug?: string }; enabled: boolean }

export function AgentInternalToolsTab({ agent }: { agent: AgentLike }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug, dashboardId } = useParams();
  const { role } = useCurrentContext();
  const canEdit = role === "owner" || role === "admin";
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const { data: connectors } = useConnectors(agent.project_id);
  const usable = (connectors ?? []).filter((c) => !c.service_dashboard_id || c.service_dashboard_id === agent.service_dashboard_id);
  const ids = useMemo(() => usable.map((c) => c.id), [usable]);
  const { data: credentials } = useCredentials(agent.project_id, ids);

  const { data: rows } = useQuery({
    queryKey: ["internal_agent_tools", agent.id, "custom_connector"],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_tools").select("id, config, enabled")
        .eq("agent_id", agent.id).eq("kind", "custom_connector");
      return (data ?? []) as ToolRow[];
    },
  });
  const rowFor = (c: CustomConnector) => (rows ?? []).find((r) => r.config?.connector_id === c.id);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
  };

  async function toggle(c: CustomConnector) {
    const row = rowFor(c);
    const { error } = row
      ? await supabase.from("internal_agent_tools").delete().eq("id", row.id)
      : await supabase.from("internal_agent_tools").insert({
          agent_id: agent.id, kind: "custom_connector", name: `${c.name} (outil interne)`, description: c.description,
          config: { connector_id: c.id, slug: c.slug, operations: [], credential_id: null }, requires_approval: false,
        });
    if (error) toast.error("Modification refusée", error.message);
    else { if (!row) setOpen(c.id); refresh(); }
  }

  async function patch(row: ToolRow, config: ToolRow["config"]) {
    const { error } = await supabase.from("internal_agent_tools").update({ config: { ...row.config, ...config } }).eq("id", row.id);
    if (error) toast.error("Modification refusée", error.message);
    refresh();
  }

  const base = dashboardId ? `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}/connectors/internal` : null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-start justify-between gap-3 pb-4">
        <div>
          <h2 className="text-lg font-semibold">Outils internes</h2>
          <p className="mt-1 max-w-lg text-sm text-muted-foreground">
            Les outils hébergés par l'entreprise que ce collaborateur peut utiliser, avec quel profil d'accès et quelles opérations.
          </p>
        </div>
        {base && (
          <Button variant="outline" size="sm" className="shrink-0 rounded-full" onClick={() => navigate(base)}>
            <ExternalLink className="mr-1 h-3.5 w-3.5" /> Gérer les outils
          </Button>
        )}
      </div>

      {usable.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-10 text-center">
          <Wrench className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">Aucun outil interne déclaré pour ce service.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {!canEdit && <p className="text-[11px] text-muted-foreground">Seuls les owners et admins confient un outil interne.</p>}
          {usable.map((c) => {
            const row = rowFor(c);
            const ops = normalizeOperations(c.operations);
            const policy = normalizePolicy(c.policy);
            const granted = row?.config?.operations ?? [];
            const creds = (credentials ?? []).filter((x) => x.connector_id === c.id && x.status === "active");
            const isOpen = open === c.id && !!row;
            return (
              <div key={c.id} className={cn("rounded-xl border p-3", row ? "border-primary/40" : "border-border")}>
                <div className="flex items-center gap-3">
                  <button type="button" disabled={!row} onClick={() => setOpen(isOpen ? null : c.id)} className="text-muted-foreground disabled:opacity-30" aria-label="Détail">
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {c.name}
                      {c.status !== "active" && <Pill tone="amber">{c.status === "draft" ? "Brouillon : invisible tant qu'inactif" : "Désactivé"}</Pill>}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {row ? (granted.length ? `${granted.length} opération(s) accordée(s)` : "Toutes les opérations") : `${ops.length} opérations disponibles`}
                      {row && ` · profil : ${creds.find((x) => x.id === row.config?.credential_id)?.label ?? (creds[0] ? `${creds[0].label} (par défaut)` : "aucun")}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => toggle(c)}
                    className={cn("rounded-full px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-60",
                      row ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground hover:text-foreground")}
                  >
                    {row ? "Confié" : "Confier"}
                  </button>
                </div>

                {isOpen && row && (
                  <div className="mt-3 space-y-3 border-t border-border pt-3">
                    <label className="block space-y-1">
                      <span className="text-xs font-medium">Profil d'identifiants</span>
                      <select className={selectCls} disabled={!canEdit} value={row.config?.credential_id ?? ""}
                        onChange={(e) => patch(row, { credential_id: e.target.value || null })}>
                        <option value="">Par défaut (le premier profil actif)</option>
                        {creds.map((x) => <option key={x.id} value={x.id}>{x.label}{x.identity ? ` · ${x.identity}` : ""}</option>)}
                      </select>
                    </label>
                    <div>
                      <span className="text-xs font-medium">Opérations accordées</span>
                      <p className="text-[11px] text-muted-foreground">Rien de coché : toutes. Les opérations irréversibles attendent toujours une approbation humaine.</p>
                      <div className="mt-1.5 space-y-0.5">
                        {[...ops.map((o) => ({ name: o.name, desc: o.description, risk: o.risk })),
                          ...(policy.allow_raw ? [{ name: "request", desc: `Requête brute (${policy.raw_methods.join(", ")}) sur les chemins autorisés`, risk: policy.raw_methods.some((m) => m !== "GET" && m !== "HEAD") ? "write" : "read" }] : []),
                        ].map((o) => (
                          <label key={o.name} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-secondary/40">
                            <input type="checkbox" disabled={!canEdit} checked={granted.includes(o.name)}
                              onChange={(e) => patch(row, { operations: e.target.checked ? [...granted, o.name] : granted.filter((x) => x !== o.name) })} />
                            <span className="font-mono text-[11px]">{o.name}</span>
                            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{o.desc}</span>
                            <Pill tone={RISK_META[o.risk].tone}>{RISK_META[o.risk].label}</Pill>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
