import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Slack, Plus, Trash2, CheckCircle2, MessagesSquare, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import type { InternalAgent } from "./shared";

interface ChannelRow {
  id: string;
  provider: string;
  team_name: string | null;
  external_team_id: string | null;
  trigger: "mention" | "all";
  enabled: boolean;
  created_at: string;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

function ProviderBadge({ provider, size = "md" }: { provider: string; size?: "sm" | "md" }) {
  const cls = size === "sm" ? "h-9 w-9" : "h-10 w-10";
  const icon = size === "sm" ? "h-4 w-4" : "h-5 w-5";
  if (provider === "teams") {
    return <span className={cn("grid place-items-center rounded-lg bg-[#4B53BC] text-white", cls)}><MessagesSquare className={icon} /></span>;
  }
  return <span className={cn("grid place-items-center rounded-lg bg-[#4A154B] text-white", cls)}><Slack className={icon} /></span>;
}

// Connect an agent to external chat channels (Slack + Microsoft Teams). Slack uses
// a one-click OAuth install (slack-gateway builds the consent URL server-side).
// Teams uses a Bot Framework bot the operator registers once in Azure; here we
// bind the agent to a Teams tenant. The UI only reads channel metadata.
export function AgentChannelsTab({ agent }: { agent: InternalAgent }) {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { workspaceId, projectId } = useCurrentContext();
  const slackStatus = params.get("slack"); // 'connected' | 'error' | null

  const [teamsTenant, setTeamsTenant] = useState("");
  const [teamsLabel, setTeamsLabel] = useState("");
  const [addingTeams, setAddingTeams] = useState(false);
  const [copied, setCopied] = useState(false);

  const teamsEndpoint = `${SUPABASE_URL}/functions/v1/teams-gateway`;

  const { data: channels, isLoading } = useQuery({
    queryKey: ["agent_channels", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_channels")
        .select("id, provider, team_name, external_team_id, trigger, enabled, created_at")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: false });
      return (data ?? []) as ChannelRow[];
    },
  });

  const installUrl = useMemo(() => {
    const u = new URL(`${SUPABASE_URL}/functions/v1/slack-gateway`);
    u.searchParams.set("install", "1");
    u.searchParams.set("agent_id", agent.id);
    u.searchParams.set("return_to", window.location.pathname);
    return u.toString();
  }, [agent.id]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["agent_channels", agent.id] });
  const setTrigger = async (id: string, trigger: "mention" | "all") => {
    await supabase.from("internal_agent_channels").update({ trigger }).eq("id", id);
    invalidate();
  };
  const setEnabled = async (id: string, enabled: boolean) => {
    await supabase.from("internal_agent_channels").update({ enabled }).eq("id", id);
    invalidate();
  };
  const disconnect = async (id: string) => {
    if (!confirm("Disconnect this channel? The agent stops responding there.")) return;
    await supabase.from("internal_agent_channels").delete().eq("id", id);
    invalidate();
  };
  const clearStatus = () => {
    const n = new URLSearchParams(params);
    n.delete("slack");
    setParams(n, { replace: true });
  };

  async function addTeams() {
    const tenant = teamsTenant.trim();
    if (!tenant || !workspaceId || !projectId) return;
    setAddingTeams(true);
    try {
      const { error } = await supabase.from("internal_agent_channels").insert({
        workspace_id: workspaceId, project_id: projectId, agent_id: agent.id,
        provider: "teams", external_team_id: tenant, team_name: teamsLabel.trim() || null,
        enabled: true, created_by: user?.id ?? null,
      });
      if (error) { alert(error.message); return; }
      setTeamsTenant(""); setTeamsLabel("");
      invalidate();
    } finally {
      setAddingTeams(false);
    }
  }

  async function copyEndpoint() {
    try { await navigator.clipboard.writeText(teamsEndpoint); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  }

  return (
    <div className="space-y-6 py-6">
      <div>
        <h3 className="text-lg font-semibold">Channels</h3>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Connectez <span className="font-medium text-foreground">{agent.name}</span> à Slack ou Microsoft Teams — votre équipe le @mentionne
          dans un canal et reçoit la réponse dans le fil, avec le contexte des échanges.
        </p>
      </div>

      {slackStatus === "connected" && (
        <div className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400">
          <span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> Slack connecté. Invitez le bot dans un canal, puis @mentionnez l'agent.</span>
          <button onClick={clearStatus} className="opacity-70 hover:opacity-100">Dismiss</button>
        </div>
      )}
      {slackStatus === "error" && (
        <div className="flex items-center justify-between rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-400">
          <span>La connexion Slack a échoué. Réessayez.</span>
          <button onClick={clearStatus} className="opacity-70 hover:opacity-100">Dismiss</button>
        </div>
      )}

      {/* Slack connect card */}
      <div className="rounded-xl border border-border p-5">
        <div className="flex items-center gap-3">
          <ProviderBadge provider="slack" />
          <div className="flex-1">
            <div className="font-medium">Slack</div>
            <div className="text-xs text-muted-foreground">Mention &amp; réponse dans les canaux et DMs.</div>
          </div>
          <a href={installUrl}>
            <Button><Plus className="mr-1.5 h-4 w-4" /> Add to Slack</Button>
          </a>
        </div>
      </div>

      {/* Teams connect card */}
      <div className="rounded-xl border border-border p-5">
        <div className="flex items-center gap-3">
          <ProviderBadge provider="teams" />
          <div className="flex-1">
            <div className="font-medium">Microsoft Teams</div>
            <div className="text-xs text-muted-foreground">Bot Framework — mention &amp; réponse dans les canaux Teams.</div>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Messaging endpoint (à coller dans votre Azure Bot)</label>
            <div className="flex items-center gap-2">
              <Input readOnly value={teamsEndpoint} className="h-9 font-mono text-[11px]" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={copyEndpoint}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Tenant ID (Azure AD)</label>
              <Input value={teamsTenant} onChange={(e) => setTeamsTenant(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" className="h-9" />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Nom (optionnel)</label>
              <Input value={teamsLabel} onChange={(e) => setTeamsLabel(e.target.value)} placeholder="ex. Espace de travail Acme" className="h-9" />
            </div>
            <div className="flex items-end">
              <Button className="h-9 w-full" onClick={addTeams} disabled={addingTeams || !teamsTenant.trim()}>
                <Plus className="mr-1.5 h-4 w-4" /> Connecter
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Connected channels */}
      {isLoading ? (
        <div className="h-20 animate-pulse rounded-lg bg-muted/40" />
      ) : !channels || channels.length === 0 ? (
        <EmptyState icon={Slack} title="Aucun canal connecté" description="Connectez Slack (en un clic) ou Teams (via votre bot Azure)." />
      ) : (
        <div className="space-y-2">
          {channels.map((c) => (
            <div key={c.id} className={cn("flex items-center gap-3 rounded-lg border border-border p-3", !c.enabled && "opacity-60")}>
              <ProviderBadge provider={c.provider} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {c.team_name ?? c.external_team_id ?? (c.provider === "teams" ? "Teams tenant" : "Slack workspace")}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {c.provider === "teams" ? "Teams" : "Slack"} · répond sur : {c.trigger === "all" ? "chaque message" : "@mention"}
                </div>
              </div>
              <select
                value={c.trigger}
                onChange={(e) => setTrigger(c.id, e.target.value as "mention" | "all")}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                <option value="mention">Sur @mention</option>
                <option value="all">Chaque message</option>
              </select>
              <Button size="sm" variant="ghost" onClick={() => setEnabled(c.id, !c.enabled)}>{c.enabled ? "Désactiver" : "Activer"}</Button>
              <Button size="sm" variant="ghost" onClick={() => disconnect(c.id)} title="Disconnect"><Trash2 className="h-4 w-4 text-destructive" /></Button>
            </div>
          ))}
        </div>
      )}

      {/* How it works */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-muted/20 p-5 text-sm">
          <div className="flex items-center gap-2 font-medium"><Slack className="h-4 w-4" /> Slack</div>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>Cliquez <span className="font-medium text-foreground">Add to Slack</span> et autorisez l'app.</li>
            <li>Ajoutez le bot à un canal (<span className="font-mono text-foreground">/invite @bot</span>).</li>
            <li>@mentionnez le bot — il répond dans le fil en tant que <span className="font-medium text-foreground">{agent.name}</span>.</li>
            <li><span className="font-mono text-foreground">@bot mission: …</span> crée une mission suivie et poste le rapport ici.</li>
          </ol>
        </div>
        <div className="rounded-xl border border-border bg-muted/20 p-5 text-sm">
          <div className="flex items-center gap-2 font-medium"><MessagesSquare className="h-4 w-4" /> Microsoft Teams</div>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>Créez un <span className="font-medium text-foreground">Azure Bot</span> (portail Azure) et notez son <span className="font-medium text-foreground">App ID</span> + secret.</li>
            <li>Réglez son <span className="font-medium text-foreground">messaging endpoint</span> sur l'URL ci-dessus. Côté serveur, définissez les secrets <span className="font-mono text-foreground">MICROSOFT_APP_ID</span> et <span className="font-mono text-foreground">MICROSOFT_APP_PASSWORD</span>.</li>
            <li>Publiez un <span className="font-medium text-foreground">manifeste d'app Teams</span> référençant le bot et installez-le dans Teams.</li>
            <li>Collez votre <span className="font-medium text-foreground">Tenant ID</span> ci-dessus → Connecter. @mentionnez le bot dans un canal ; <span className="font-mono text-foreground">mission: …</span> fonctionne aussi.</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
