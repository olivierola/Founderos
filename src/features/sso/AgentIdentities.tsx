// Authentification → Identités des agents (docs/enterprise-generalisation.md G1).
//
// Pour agir au nom d'une personne, un agent a sa propre identité auprès de
// l'IdP : un client Keycloak, Okta…, ou une application Entra ID. Ses limites
// (audiences, scopes, rôles d'application) s'ajoutent à celles de la personne.
// Le secret part chiffré vers sso-admin et ne revient jamais au navigateur.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon as Plus, TrashIcon as Trash, PlugsConnectedIcon as TestIcon, CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ToastProvider";
import { useConfirm } from "@/components/ConfirmProvider";
import { Field, Pill, SectionTitle, inputCls, selectCls } from "@/features/custom-connectors/ui";
import {
  deleteAgentIdentity, listAgentIdentities, listAgents, qk, saveAgentIdentity, testDelegation,
  type AgentIdentity, type DelegationTestResult, type SsoProvider,
} from "./api";

export function AgentIdentities({ workspaceId, providers }: { workspaceId: string; providers: SsoProvider[] }) {
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const identities = useQuery({ queryKey: qk.identities(workspaceId), queryFn: () => listAgentIdentities(workspaceId) });
  const agents = useQuery({ queryKey: qk.agents(workspaceId), queryFn: () => listAgents(workspaceId) });
  const [form, setForm] = useState<null | { agentId: string; providerId: string; clientId: string; secret: string; userScope: string; editing: boolean }>(null);
  const [saving, setSaving] = useState(false);
  const [tests, setTests] = useState<Record<string, DelegationTestResult | "running">>({});

  const agentName = (id: string) => agents.data?.find((a) => a.id === id)?.name ?? id.slice(0, 8);
  const provider = (id: string) => providers.find((p) => p.id === id);
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.identities(workspaceId) });

  function startNew() {
    setForm({ agentId: agents.data?.[0]?.id ?? "", providerId: providers[0]?.id ?? "", clientId: "", secret: "", userScope: "", editing: false });
  }

  function startEdit(i: AgentIdentity) {
    setForm({ agentId: i.agent_id, providerId: i.provider_id, clientId: i.client_id, secret: "", userScope: i.user_scope ?? "", editing: true });
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      await saveAgentIdentity(workspaceId, {
        agent_id: form.agentId, provider_id: form.providerId, client_id: form.clientId.trim(),
        ...(form.secret.trim() ? { client_secret: form.secret.trim() } : {}),
        ...(form.userScope.trim() ? { user_scope: form.userScope.trim() } : {}),
      });
      toast.success("Identité enregistrée");
      setForm(null);
      await refresh();
    } catch (e) {
      toast.error("Enregistrement impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(i: AgentIdentity) {
    if (!(await confirm({
      title: `Retirer l'identité de « ${agentName(i.agent_id)} » ?`,
      description: "Cet agent ne pourra plus agir au nom des personnes auprès de ce fournisseur.",
      confirmText: "Retirer",
    }))) return;
    try {
      await deleteAgentIdentity(workspaceId, i.id);
      await refresh();
    } catch (e) {
      toast.error("Suppression impossible", e instanceof Error ? e.message : String(e));
    }
  }

  async function test(i: AgentIdentity) {
    const audience = window.prompt("Audience à tester (facultatif) : le serveur ou l'outil visé, ex. mcp-prd ou api://mcp-prd", "") ?? "";
    setTests((t) => ({ ...t, [i.id]: "running" }));
    try {
      const out = await testDelegation(workspaceId, { provider_id: i.provider_id, agent_id: i.agent_id, ...(audience.trim() ? { audience: audience.trim() } : {}) });
      setTests((t) => ({ ...t, [i.id]: out }));
    } catch (e) {
      setTests((t) => ({ ...t, [i.id]: { ok: false, detail: e instanceof Error ? e.message : String(e) } }));
    }
  }

  const selected = form ? provider(form.providerId) : undefined;
  const list = identities.data ?? [];

  return (
    <section>
      <SectionTitle aside={<Button size="sm" onClick={startNew} disabled={!agents.data?.length}><Plus className="mr-1 h-3.5 w-3.5" /> Ajouter une identité</Button>}>
        Identités des agents
      </SectionTitle>
      <p className="mb-3 max-w-3xl text-[11px] text-muted-foreground">
        Un agent qui agit au nom d'une personne présente sa propre identité à l'IdP. Ses limites (audiences, scopes, rôles d'application)
        s'ajoutent à celles de la personne : il ne peut jamais faire plus que ce que les deux permettent.
      </p>

      {identities.isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : list.length === 0 && !form ? (
        <p className="text-xs text-muted-foreground">Aucune identité : aucun agent ne peut encore agir au nom des personnes.</p>
      ) : (
        <div className="space-y-2">
          {list.map((i) => {
            const p = provider(i.provider_id);
            const result = tests[i.id];
            return (
              <div key={i.id} className="rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{agentName(i.agent_id)}</span>
                  <Pill tone="violet">{p?.name ?? "fournisseur retiré"}</Pill>
                  <span className="font-mono text-[11px]">{i.client_id}</span>
                  {i.secret_hint && <span className="font-mono text-[10px] text-muted-foreground">{i.secret_hint}</span>}
                  <div className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => test(i)} disabled={result === "running"}>
                      {result === "running" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <TestIcon className="mr-1 h-3.5 w-3.5" />} Tester
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => startEdit(i)}>Modifier</Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(i)}><Trash className="mr-1 h-3.5 w-3.5" /> Retirer</Button>
                  </div>
                </div>
                {i.user_scope && <div className="mt-1 text-[11px] text-muted-foreground">Jeton de la personne demandé pour : {i.user_scope}</div>}
                {result && result !== "running" && (
                  <div className={result.ok ? "mt-2 text-[11px] text-emerald-700 dark:text-emerald-300" : "mt-2 text-[11px] text-red-600"}>
                    {result.detail}
                    {result.claims && (
                      <pre className="mt-1 overflow-auto rounded bg-muted p-2 text-[10px] text-foreground">{JSON.stringify(result.claims, null, 2)}</pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {form && (
        <div className="mt-3 max-w-3xl space-y-3 rounded-xl border border-border p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Agent">
              <select className={selectCls} value={form.agentId} disabled={form.editing} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
                {(agents.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Fournisseur">
              <select className={selectCls} value={form.providerId} disabled={form.editing} onChange={(e) => setForm({ ...form, providerId: e.target.value })}>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={selected?.delegation === "entra_obo" ? "ID d'application de l'agent" : "Client de l'agent"} hint={selected?.delegation === "entra_obo" ? "Application Entra propre à l'agent, avec une API exposée et un secret client." : "Client confidentiel, échange de jeton autorisé, ex. agent-ops-investigator."}>
              <input className={inputCls} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} />
            </Field>
            <Field label="Secret" hint={form.editing ? "Laisser vide pour le conserver." : "Chiffré par FounderOS, jamais réaffiché."}>
              <input className={inputCls} type="password" autoComplete="off" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
            </Field>
          </div>
          {selected?.delegation === "entra_obo" && (
            <Field label="Portée du jeton de la personne" hint="La ressource de l'application de l'agent, que le portail demande avant l'On-Behalf-Of. Vide : api://<ID d'application>/.default.">
              <input className={inputCls} value={form.userScope} placeholder={`api://${form.clientId || "<ID d'application>"}/.default`} onChange={(e) => setForm({ ...form, userScope: e.target.value })} />
            </Field>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={saving || !form.agentId || !form.providerId || !form.clientId.trim() || (!form.editing && !form.secret.trim())}>
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Enregistrer
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setForm(null)}>Annuler</Button>
          </div>
        </div>
      )}
    </section>
  );
}
